import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ─── Config ───────────────────────────────────────────────────────────────────

const CBRE_BASE = "https://www.cbre.com";
const CBRE_PAGE_URL = `${CBRE_BASE}/properties/properties-for-lease/commercial-space`;
const CBRE_API_URL = `${CBRE_BASE}/listings-api/propertylistings/query`;

const DEFAULT_FILTER = {
  location: "Dallas Downtown Historic District, Dallas, TX, USA",
  propertyTypes: ["Office", "Retail"],
  // Two diagonal corners — server builds full bounding-box polygon
  polygon: [
    [32.79231919690079, -96.78189179351807],
    [32.77251109127289, -96.81691071441651],
  ],
  pageSize: 1000,
  page: 1,
};

// ─── Polygon builder ──────────────────────────────────────────────────────────
// CBRE expects PolygonFilters = array of closed rings
// Each point = ["lat", "lon"] as strings
// From two diagonal corners → 5-point closed bounding box

function buildPolygonFilter(corners) {
  const lats = corners.map((c) => c[0]);
  const lons = corners.map((c) => c[1]);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);

  // CBRE format: each point is "lat,lon" as a single comma-joined string
  // Closed ring: SW → NW → NE → SE → SW
  const pt = (lat, lon) => `${lat},${lon}`;
  return [
    [
      pt(minLat, minLon),
      pt(maxLat, minLon),
      pt(maxLat, maxLon),
      pt(minLat, maxLon),
      pt(minLat, minLon),
    ],
  ];
}

// ─── Browser helpers ──────────────────────────────────────────────────────────

async function launchBrowser() {
  return puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      process.env.CHROME_BIN ||
      puppeteer.executablePath(),
  });
}

async function setupPage(browser) {
  const page = await browser.newPage();

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    window.chrome = { runtime: {} };
  });

  // Match exact browser headers from the working curl
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"
  );

  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
    Accept: "application/json, text/plain, */*",
    "sec-ch-ua":
      '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-ch-ua-arch": '"x86"',
    "sec-ch-ua-bitness": '"64"',
    "sec-ch-ua-model": '""',
    "sec-ch-ua-platform-version": '"19.0.0"',
    "sec-ch-ua-full-version-list":
      '"Chromium";v="142.0.7444.176", "Google Chrome";v="142.0.7444.176", "Not_A Brand";v="99.0.0.0"',
  });

  return page;
}

// ─── Fetch listings ───────────────────────────────────────────────────────────

async function fetchListings(page, filter) {
  const polygon = buildPolygonFilter(filter.polygon);

  // Build params exactly matching the working curl
  const params = new URLSearchParams({
    Site: "us-comm",
    CurrencyCode: "USD",
    Unit: "sqft",
    "Common.UsageType": filter.propertyTypes.join(","),
    PageSize: String(filter.pageSize),
    Page: String(filter.page),
    PolygonFilters: JSON.stringify(polygon),
  });

  const referer =
    `${CBRE_BASE}/properties/properties-for-lease/commercial-space` +
    `?sort=lastupdated%2Bdescending` +
    `&initialpolygon=${encodeURIComponent(JSON.stringify(filter.polygon))}` +
    `&location=${encodeURIComponent(filter.location)}` +
    `&propertytype=${encodeURIComponent(filter.propertyTypes.join(","))}` +
    `&transactiontype=allTypes`;

  const url = `${CBRE_API_URL}?${params.toString()}`;
  console.log(`  → URL: ${url.slice(0, 150)}...`);

  // Load CBRE first to get cookies/session
  console.log("  → Loading CBRE page for session cookies...");
  await page.goto(CBRE_PAGE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 5000));

  console.log("  → Calling listings API...");
  const result = await page.evaluate(
    async (apiUrl, refererUrl) => {
      try {
        const res = await fetch(apiUrl, {
          method: "GET",
          credentials: "include",
          headers: {
            Accept: "application/json, text/plain, */*",
            Referer: refererUrl,
          },
        });

        const text = await res.text();

        if (!res.ok) {
          return { error: true, status: res.status, body: text };
        }

        try {
          return { ok: true, data: JSON.parse(text) };
        } catch {
          return { error: true, status: res.status, body: text };
        }
      } catch (e) {
        return { error: true, message: e.message };
      }
    },
    url,
    referer
  );

  if (result?.error) {
    throw new Error(
      `API error ${result.status || ""}: ${result.body?.slice(0, 300) || result.message}`
    );
  }

  return result.data;
}

// ─── Data cleaner ─────────────────────────────────────────────────────────────

function cleanListings(raw) {
  let items = null;

  if (Array.isArray(raw)) {
    items = raw;
  } else if (Array.isArray(raw?.Documents?.[0])) {
    items = raw.Documents[0];
  } else if (Array.isArray(raw?.Documents)) {
    items = raw.Documents;
  } else if (Array.isArray(raw?.Results)) {
    items = raw.Results;
  } else if (Array.isArray(raw?.results)) {
    items = raw.results;
  } else if (Array.isArray(raw?.listings)) {
    items = raw.listings;
  } else {
    const arrayField = Object.keys(raw || {}).find((k) => Array.isArray(raw[k]));
    if (arrayField) {
      console.log(`  → Using array field: "${arrayField}"`);
      items = raw[arrayField];
    }
  }

  if (!items) {
    console.warn("  ⚠ Unknown shape. Keys:", Object.keys(raw || {}));
    console.warn("  Sample:", JSON.stringify(raw).slice(0, 500));
    return [];
  }

  return items.map((item) => {
    const addr = item["Common.ActualAddress"] || {};
    const coord = item["Common.Coordinate"] || {};
    const img = item["Dynamic.PrimaryImage"] || {};
    const sizes = item["Common.TotalSize"] || [];
    const firstSize = Array.isArray(sizes) ? sizes[0] : sizes;
    const pricing = item["Common.Pricing"] || [];
    const firstPrice = Array.isArray(pricing) ? pricing[0] : pricing;

    const id =
      item["Common.PrimaryKey"] ||
      item["Common.ListingId"] ||
      item.id ||
      "";

    return {
      id,
      name: item["Common.PropertyName"] || item["Common.BuildingName"] || "",
      address: `${addr["Common.Line1"] || ""} ${addr["Common.Line2"] || ""}`.trim(),
      city: addr["Common.Locallity"] || addr["Common.Locality"] || "",
      state: addr["Common.Region"] || "",
      zip: addr["Common.PostCode"] || "",
      country: addr["Common.Country"] || "",
      latitude: coord.lat ?? coord.latitude ?? null,
      longitude: coord.lon ?? coord.lng ?? coord.longitude ?? null,
      size: firstSize?.["Common.Size"] || 0,
      sizeUnit: firstSize?.["Common.Units"] || "sqft",
      propertyType: item["Common.UsageType"] || item["Common.PropertyType"] || "",
      transactionType: item["Common.TransactionType"] || "",
      floor: item["Common.Floor"] || null,
      suite: item["Common.Suite"] || "",
      availableDate: item["Common.AvailableDate"] || null,
      price: firstPrice?.["Common.AskingPrice"] || null,
      priceUnit: firstPrice?.["Common.PriceUnit"] || null,
      priceType: firstPrice?.["Common.PriceType"] || null,
      image:
        img?.["Common.ImageResources"]?.[0]?.["Source.Uri"] ||
        item["Dynamic.ThumbnailImage"] ||
        "",
      lastUpdated: item["Common.LastUpdated"] || null,
      link: id ? `${CBRE_BASE}/properties/${id}` : "",
    };
  });
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

async function fetchCBREListings(filter = DEFAULT_FILTER) {
  const browser = await launchBrowser();
  const page = await setupPage(browser);

  try {
    const raw = await fetchListings(page, filter);

    console.log("  → Response keys:", Object.keys(raw || {}).join(", "));
    if (raw?.TotalCount !== undefined) console.log(`  → TotalCount: ${raw.TotalCount}`);

    const listings = cleanListings(raw);
    return {
      totalCount: raw?.TotalCount ?? raw?.totalCount ?? listings.length,
      page: filter.page,
      pageSize: filter.pageSize,
      listings,
    };
  } finally {
    await browser.close();
  }
}

// ─── Filter parser ────────────────────────────────────────────────────────────

function parseFilter(query = {}, body = {}) {
  const src = Object.keys(body).length ? body : query;
  const filter = { ...DEFAULT_FILTER };

  if (src.location) filter.location = src.location;

  if (src.types || src.propertyTypes) {
    const raw = src.types || src.propertyTypes;
    filter.propertyTypes = Array.isArray(raw)
      ? raw
      : String(raw).split(",").map((s) => s.trim());
  }

  if (src.polygon) {
    try {
      filter.polygon =
        typeof src.polygon === "string" ? JSON.parse(src.polygon) : src.polygon;
    } catch { /* keep default */ }
  }

  if (src.page) filter.page = parseInt(src.page, 10) || 1;
  if (src.pageSize) filter.pageSize = Math.min(parseInt(src.pageSize, 10) || 1000, 5000);

  return filter;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({
    status: "CBRE scraper running",
    endpoints: {
      "GET /cbre": "Default Dallas Downtown filter",
      "GET /cbre?types=Office,Retail&page=1&pageSize=500": "Custom params",
      "POST /cbre": "Custom filter via JSON body",
    },
    defaultFilter: DEFAULT_FILTER,
  });
});

app.get("/cbre", async (req, res) => {
  console.log("\n=== GET /cbre ===");
  const filter = parseFilter(req.query);
  console.log("  Filter:", JSON.stringify(filter));
  try {
    const result = await fetchCBREListings(filter);
    console.log(`  ✓ ${result.listings.length} listings\n`);
    res.json({
      success: true,
      totalCount: result.totalCount,
      page: result.page,
      pageSize: result.pageSize,
      returned: result.listings.length,
      data: result.listings,
    });
  } catch (err) {
    console.error("  ✗", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/cbre", async (req, res) => {
  console.log("\n=== POST /cbre ===");
  const filter = parseFilter({}, req.body);
  console.log("  Filter:", JSON.stringify(filter));
  try {
    const result = await fetchCBREListings(filter);
    console.log(`  ✓ ${result.listings.length} listings\n`);
    res.json({
      success: true,
      totalCount: result.totalCount,
      page: result.page,
      pageSize: result.pageSize,
      returned: result.listings.length,
      data: result.listings,
    });
  } catch (err) {
    console.error("  ✗", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 http://localhost:${PORT}`);
  console.log(`   Listings → http://localhost:${PORT}/cbre\n`);
});