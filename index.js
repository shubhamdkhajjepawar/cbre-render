import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.send("CBRE API Running");
});

app.get("/cbre-properties", async (req, res) => {
  try {
    const url = "https://www.cbre.com/listings-api/propertylistings/query?Site=us-comm&PageSize=50&Page=1";

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
        "Referer": "https://www.cbre.com/",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    const data = await response.json();

    const results = data?.Results || [];

    const mapped = results.map(r => ({
      id: r.Common?.PrimaryKey,
      lat: r.Common?.Coordinate?.lat,
      lng: r.Common?.Coordinate?.lon
    }));

    res.json(mapped);

  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching CBRE data");
  }
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});