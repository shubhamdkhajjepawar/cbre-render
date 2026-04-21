import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("CBRE API running. Use /cbre");
});

async function fetchCBREData() {
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
    ],
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      process.env.CHROME_BIN ||
      puppeteer.executablePath(),
  });

  const page = await browser.newPage();

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    window.navigator.chrome = { runtime: {} };
  });

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  );

  // Capture actual API calls
  const apiCalls = [];
  page.on("response", async (response) => {
    const url = response.url();
    if (url.includes("/propertylistings/") || url.includes("/coveo/")) {
      apiCalls.push({
        url,
        status: response.status(),
        headers: response.headers(),
      });
    }
  });

  try {
    console.log("→ Loading CBRE...");

    await page.goto(
      "https://www.cbre.com/properties/properties-for-lease/commercial-space",
      { waitUntil: "networkidle2", timeout: 90000 },
    );

    console.log("→ Waiting for page load...");
    await new Promise((r) => setTimeout(r, 20000));

    // Log what API calls the page made
    console.log("\n=== API CALLS DETECTED ===");
    apiCalls.forEach((call) => {
      console.log("URL:", call.url);
      console.log("Status:", call.status);
    });
    console.log("========================\n");

    console.log("→ Extracting data from page...");

    // Get data directly from page's loaded state
    const data = await page.evaluate(() => {
      // Try to find loaded results in window
      if (window.__INITIAL_STATE__) return window.__INITIAL_STATE__;
      if (window.propertyListings) return window.propertyListings;

      // Try to extract from DOM
      const listings = [];
      document
        .querySelectorAll("[data-property-id], .property-card, .listing-card")
        .forEach((card) => {
          const id = card.getAttribute("data-property-id") || "";
          const address =
            card.querySelector(".address, .property-address")?.innerText ||
            "N/A";
          const link = card.querySelector("a")?.href || "";

          if (id || link) {
            listings.push({ id, address, link });
          }
        });

      if (listings.length > 0) {
        return { results: listings, source: "DOM" };
      }

      return null;
    });

    if (data && data.results) {
      console.log("✓ Found", data.results.length, "from", data.source);
      await browser.close();
      return data;
    }

    // If still nothing, try actual API
    console.log("→ Trying API call...");

    const token = await page.evaluate(async () => {
      try {
        const res = await fetch("/coveo/rest/token", {
          credentials: "include",
        });
        const json = await res.json();
        return json.token || json;
      } catch (e) {
        return null;
      }
    });

    console.log("Token:", token ? "OK" : "FAIL");

    if (!token) {
      throw new Error("No token");
    }

    // Try Coveo search API (what CBRE actually uses)
    const apiData = await page.evaluate(async (tkn) => {
      const res = await fetch(
        "https://platform.cloud.coveo.com/rest/search/v2",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${tkn}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            aq: "@isLetting==true",
            numberOfResults: 50,
            sortCriteria: "date descending",
          }),
        },
      );

      return await res.json();
    }, token);

    console.log(
      "API response:",
      apiData.totalCount || apiData.results?.length || 0,
      "results",
    );

    await browser.close();
    return apiData;
  } catch (err) {
    await browser.close();
    throw err;
  }
}

function cleanData(data) {
  if (data.source === "DOM") {
    return data.results;
  }

  // Coveo format
  if (data.results) {
    return data.results.map((item) => {
      const raw = item.raw || {};
      return {
        id: raw.cbreprimarykey || item.uniqueId || "",
        address: raw.cbreactualaddress || raw.title || "N/A",
        latitude: raw.latitude ?? null,
        longitude: raw.longitude ?? null,
        size: raw.cbretotalsize || "N/A",
        image: raw.cbreprimaryimage || "https://via.placeholder.com/400x300",
        link: item.clickUri || raw.uri || "",
      };
    });
  }

  // Original format
  const results = data.Results || [];
  return results.map((item) => {
    const common = item.Common || {};
    const coord = common.Coordinate || {};
    const dynamic = item.Dynamic || {};
    return {
      id: common.PrimaryKey || "",
      address: common.ActualAddress || "N/A",
      latitude: coord.Latitude ?? null,
      longitude: coord.Longitude ?? null,
      size: common.TotalSize || "N/A",
      image: dynamic.PrimaryImage || "https://via.placeholder.com/400x300",
      link: "https://www.cbre.com/properties/" + (common.PrimaryKey || ""),
    };
  });
}

/*function cleanData(data) {
  const results = data.results || data.Results || [];
  return results.map((item) => {
    const common = item.Common || {};
    const coord = common.Coordinate || {};
    const dynamic = item.Dynamic || {};
    return {
      id: common.PrimaryKey || "",
      address: common.ActualAddress || "N/A",
      latitude: coord.Latitude ?? null,
      longitude: coord.Longitude ?? null,
      size: common.TotalSize || "N/A",
      image: dynamic.PrimaryImage || "https://via.placeholder.com/400x300",
      link: "https://www.cbre.com/properties/" + (common.PrimaryKey || "")
    };
  });
}*/

app.get("/cbre", async (req, res) => {
  try {
    console.log("\n=== CBRE FETCH ===");
    const raw = await fetchCBREData();
    const cleaned = cleanData(raw);
    console.log(`✓ ${cleaned.length} listings\n`);
    res.json({
      success: true,
      count: cleaned.length,
      data: cleaned,
    });
  } catch (err) {
    console.error("✗ ERROR:", err.message);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 http://localhost:${PORT}/cbre\n`);
});
