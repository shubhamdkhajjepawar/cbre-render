import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";

const app = express();
app.use(cors());

const PORT = 3000;

/* =====================================
   ROOT
===================================== */
app.get("/", (req, res) => {
  res.send("CBRE API running. Use /cbre");
});

/* =====================================
   BUILD POLYGON (FROM YOUR URL)
===================================== */
function buildPolygon() {
  return encodeURIComponent(JSON.stringify([
    [
      [70.05581937944501, -42.98639699999999],
      [70.05581937944501, 173.576103],
      [3.0899831093194123, 173.576103],
      [3.0899831093194123, -42.98639699999999],
      [70.05581937944501, -42.98639699999999]
    ]
  ]));
}

/* =====================================
   FETCH CBRE DATA USING BROWSER
===================================== */
async function fetchCBREData() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();

  try {
    console.log("Opening CBRE website...");

    await page.goto(
      "https://www.cbre.com/properties/properties-for-lease/commercial-space",
      { waitUntil: "networkidle2" }
    );

    // Wait for Cloudflare + scripts
    await new Promise((r) => setTimeout(r, 5000));

    console.log("Fetching token...");

    const token = await page.evaluate(async () => {
      const res = await fetch("/coveo/rest/token");
      return await res.text();
    });

    if (!token) throw new Error("Token not found");

    console.log("Token received");

    const polygon = buildPolygon();

    const apiUrl =
      "https://www.cbre.com/listings-api/propertylistings/query" +
      "?Site=us-comm" +
      "&CurrencyCode=USD" +
      "&Unit=sqft" +
      "&Common.Aspects=isLetting" +
      "&PageSize=50" +
      "&Page=1" +
      "&PolygonFilters=" + polygon +
      "&Sort=desc(Common.LastUpdated)";

    console.log("Fetching listings...");

    const data = await page.evaluate(async (url, token) => {
      const res = await fetch(url, {
        headers: {
          "accept": "application/json",
          "authorization": `Bearer ${token}`
        }
      });

      return await res.json();
    }, apiUrl, token);

    await browser.close();

    return data;

  } catch (err) {
    await browser.close();
    throw err;
  }
}

/* =====================================
   CLEAN DATA
===================================== */
function cleanData(data) {
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
      image:
        dynamic.PrimaryImage ||
        "https://via.placeholder.com/400x300",
      link:
        "https://www.cbre.com/properties/" +
        (common.PrimaryKey || "")
    };
  });
}

/* =====================================
   API ROUTE
===================================== */
app.get("/cbre", async (req, res) => {
  try {
    console.log("STARTING CBRE FETCH...");

    const raw = await fetchCBREData();

    const cleaned = cleanData(raw);

    res.json({
      success: true,
      count: cleaned.length,
      data: cleaned
    });

  } catch (err) {
    console.error("ERROR:", err.message);

    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/* =====================================
   START SERVER
===================================== */
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});