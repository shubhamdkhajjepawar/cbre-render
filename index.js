import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";
import { execSync } from "child_process";
import { existsSync } from "fs";

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
  polygon: [
    [32.79231919690079, -96.78189179351807],
    [32.77251109127289, -96.81691071441651],
  ],
  pageSize: 1000,
  page: 1,
};

// ─── Chrome installer + resolver ──────────────────────────────────────────────

async function ensureChrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    const p = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (existsSync(p)) {
      console.log(`  → Chrome from env: ${p}`);
      return p;
    }
    console.warn(`  ⚠ PUPPETEER_EXECUTABLE_PATH set but file missing: ${p}`);
  }

  let expected;
  try {
    expected = puppeteer.executablePath();
  } catch {
    expected = null;
  }

  if (expected && existsSync(expected)) {
    console.log(`  → Chrome exists: ${expected}`);
    return expected;
  }

  console.log(`  → Chrome not found at: ${expected}`);
  console.log("  → Installing Chrome at runtime...");
  try {
    execSync("npx puppeteer browsers install chrome", {
      stdio: "inherit",
      timeout: 120000,
    });
    console.log("  → Chrome installed.");
  } catch (err) {
    throw new Error(`Failed to install Chrome at runtime: ${err.message}`);
  }

  try {
    const fresh = puppeteer.executablePath();
    if (existsSync(fresh)) {
      console.log(`  → Chrome ready: ${fresh}`);
      return fresh;
    }
  } catch { /* fall through */ }

  throw new Error("Chrome install ran but binary still not found.");
}

// ─── Polygon builder ──────────────────────────────────────────────────────────

function buildPolygonFilter(corners) {
  const lats = corners.map((c) => c[0]);
  const lons = corners.map((c) => c[1]);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
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
  const executablePath = await ensureChrome();

  return puppeteer.launch({
    headless: "new",
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
    ],
  });
}

async function setupPage(browser) {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(90000);
  page.setDefaultTimeout(90000);

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    window.chrome = { runtime: {} };
  });

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );

  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
    Accept: "application/json, text/plain, */*",
    "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not_A Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
  });

  return page;
}

// ─── Fetch listings (with retry) ──────────────────────────────────────────────

async function fetchListings(page, filter, attempt = 1) {
  const MAX_ATTEMPTS = 3;

  const polygon = buildPolygonFilter(filter.polygon);

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

  try {
    console.log(`  → [attempt ${attempt}] Loading CBRE page...`);
    await page.goto(CBRE_PAGE_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    await new Promise((r) => setTimeout(r, 6000));
    await page.evaluate(() => document.readyState);

    console.log(`  → [attempt ${attempt}] Calling listings API...`);
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
          if (!res.ok) return { error: true, status: res.status, body: text };
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

  } catch (err) {
    const isRetryable =
      err.message.includes("detached") ||
      err.message.includes("Target closed") ||
      err.message.includes("Session closed") ||
      err.message.includes("Navigation failed") ||
      err.message.includes("net::ERR");

    if (isRetryable && attempt < MAX_ATTEMPTS) {
      console.warn(`  ⚠ Retryable error (attempt ${attempt}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000));
      try { await page.close(); } catch { /* already dead */ }
      const freshPage = await setupPage(page.browser());
      return fetchListings(freshPage, filter, attempt + 1);
    }

    throw err;
  }
}

// ─── Data cleaner ─────────────────────────────────────────────────────────────

function cleanListings(raw) {
  let items = null;

  if (Array.isArray(raw)) items = raw;
  else if (Array.isArray(raw?.Documents?.[0])) items = raw.Documents[0];
  else if (Array.isArray(raw?.Documents)) items = raw.Documents;
  else if (Array.isArray(raw?.Results)) items = raw.Results;
  else if (Array.isArray(raw?.results)) items = raw.results;
  else if (Array.isArray(raw?.listings)) items = raw.listings;
  else {
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
    const id = item["Common.PrimaryKey"] || item["Common.ListingId"] || item.id || "";

    // Build slug
    const buildSlug = () => {
      const name = (item["Common.PropertyName"] || item["Common.BuildingName"] || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const street = (addr["Common.Line1"] || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const city = (addr["Common.Locallity"] || addr["Common.Locality"] || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-");
      const state = (addr["Common.Region"] || "").toLowerCase();
      const zip = addr["Common.PostCode"] || "";
      
      return `${name}/${street}-${city}-${state}-${zip}`
        .replace(/\/+/g, "/")
        .replace(/-+/g, "-")
        .replace(/\/-|-\//g, "/");
    };

    const slug = id ? buildSlug() : "";
    const detailUrl = id 
      ? `${CBRE_BASE}/properties/properties-for-lease/commercial-space/details/${id}/${slug}`
      : "";

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
      link: detailUrl,
      propertyUrl: detailUrl,
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
    await browser.close().catch(() => {});
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
      "GET /health": "Chrome path + disk check",
    },
    defaultFilter: DEFAULT_FILTER,
  });
});

app.get("/health", async (req, res) => {
  try {
    const chromePath = await ensureChrome();
    res.json({ status: "ok", chrome: chromePath, exists: existsSync(chromePath) });
  } catch (err) {
    res.status(500).json({ status: "error", error: err.message });
  }
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

app.listen(PORT, async () => {
  console.log(`\n🚀 http://localhost:${PORT}`);
  console.log(`   Listings → http://localhost:${PORT}/cbre\n`);
  try {
    const chromePath = await ensureChrome();
    console.log(`   ✓ Chrome ready: ${chromePath}\n`);
  } catch (err) {
    console.error(`   ✗ Chrome setup failed: ${err.message}\n`);
  }
});
