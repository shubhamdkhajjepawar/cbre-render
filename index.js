import express from "express";
import puppeteer from "puppeteer";

const app = express();
const PORT = process.env.PORT || 10000;

// Health check
app.get("/", (req, res) => {
  res.send("CBRE API Running with Puppeteer");
});

// Main API
app.get("/cbre-properties", async (req, res) => {
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();

    // Open CBRE page (IMPORTANT)
    await page.goto(
      "https://www.cbre.com/properties/properties-for-lease/commercial-space",
      { waitUntil: "networkidle2" },
    );

    // Call API from inside browser context
    const data = await page.evaluate(async () => {
      const response = await fetch(
        "https://www.cbre.com/listings-api/propertylistings/query?Site=us-comm&Common.Aspects=isLetting&Common.UsageType=Office%2CRetail&PageSize=50&Page=1",
      );
      return response.json();
    });

    const results = data?.Results || [];

    const mapped = results.map((r) => ({
      id: r.Common?.PrimaryKey,
      lat: r.Common?.Coordinate?.lat,
      lng: r.Common?.Coordinate?.lon,
    }));

    res.json({
      total: mapped.length,
      data: mapped,
    });
  } catch (err) {
    console.error("ERROR:", err);
    res.status(500).send("Error fetching CBRE data");
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
