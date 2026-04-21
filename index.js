import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";
import { execSync } from "child_process";
import { existsSync } from "fs";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

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

// ─── Chrome setup ─────────────────────────────────────────────────────────────

async function ensureChrome() {
  // Try env var first
  if (
    process.env.PUPPETEER_EXECUTABLE_PATH &&
    existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)
  ) {
    console.log(`✓ Chrome from env: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  // Common system paths
  const systemPaths = [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
    process.env.PUPPETEER_EXECUTABLE_PATH,
  ].filter(Boolean);

  for (const path of systemPaths) {
    if (existsSync(path)) {
      console.log(`✓ Chrome found: ${path}`);
      return path;
    }
  }

  // Try puppeteer default
  try {
    const defaultPath = puppeteer.executablePath();
    if (existsSync(defaultPath)) {
      console.log(`✓ Chrome at default: ${defaultPath}`);
      return defaultPath;
    }
  } catch (e) {
    console.log("No default Chrome path");
  }

  // Install
  console.log("→ Installing Chrome...");
  try {
    execSync("npx @puppeteer/browsers install chrome@stable", {
      stdio: "inherit",
      timeout: 180000,
    });
  } catch (err) {
    throw new Error(`Chrome install failed: ${err.message}`);
  }

  // Retry default path
  try {
    const installed = puppeteer.executablePath();
    if (existsSync(installed)) {
      console.log(`✓ Chrome installed: ${installed}`);
      return installed;
    }
  } catch {}

  throw new Error("Chrome install succeeded but binary not found");
}

// ─── Browser ──────────────────────────────────────────────────────────────────

async function launchBrowser() {
  const executablePath = await ensureChrome();

  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
    "--disable-web-security",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--metrics-recording-only",
    "--mute-audio",
    "--no-first-run",
    "--safebrowsing-disable-auto-update",
    "--single-process", // Risky but helps in constrained envs
  ];

  console.log("→ Launching browser...");

  const browser = await puppeteer.launch({
    headless: "shell", // More stable than "new"
    executablePath,
    args,
    timeout: 120000, // Increase timeout
    protocolTimeout: 120000,
    dumpio: false, // Set true for debugging
  });

  console.log("✓ Browser launched");
  return browser;
}

async function setupPage(browser) {
  const page = await browser.newPage();

  await page.setViewport({ width: 1920, height: 1080 });
  await page.setDefaultNavigationTimeout(90000);
  await page.setDefaultTimeout(90000);

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    window.chrome = { runtime: {} };
  });

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  );

  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
    Accept: "application/json, text/plain, */*",
    "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
  });

  return page;
}

// ─── Polygon ──────────────────────────────────────────────────────────────────

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

// ─── Fetch ────────────────────────────────────────────────────────────────────

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
    console.log(`→ [${attempt}/${MAX_ATTEMPTS}] Loading page...`);

    await page.goto(CBRE_PAGE_URL, {
      waitUntil: "networkidle2",
      timeout: 90000,
    });

    await new Promise((r) => setTimeout(r, 8000)); // Let JS settle

    console.log(`→ [${attempt}/${MAX_ATTEMPTS}] Calling API...`);

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
      referer,
    );

    if (result?.error) {
      throw new Error(
        `API error ${result.status || ""}: ${result.body?.slice(0, 300) || result.message}`,
      );
    }

    console.log("✓ Data received");
    return result.data;
  } catch (err) {
    const isRetryable =
      err.message.includes("detached") ||
      err.message.includes("Target closed") ||
      err.message.includes("Session closed") ||
      err.message.includes("Navigation") ||
      err.message.includes("net::ERR") ||
      err.message.includes("timeout");

    if (isRetryable && attempt < MAX_ATTEMPTS) {
      console.warn(`⚠ Retry ${attempt}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5000));

      try {
        await page.close();
      } catch {}

      const freshPage = await setupPage(page.browser());
      return fetchListings(freshPage, filter, attempt + 1);
    }

    throw err;
  }
}

// ─── Clean ────────────────────────────────────────────────────────────────────

function cleanListings(raw) {
  let items = null;

  if (Array.isArray(raw)) items = raw;
  else if (Array.isArray(raw?.Documents?.[0])) items = raw.Documents[0];
  else if (Array.isArray(raw?.Documents)) items = raw.Documents;
  else if (Array.isArray(raw?.Results)) items = raw.Results;
  else if (Array.isArray(raw?.results)) items = raw.results;
  else if (Array.isArray(raw?.listings)) items = raw.listings;
  else {
    const arrayField = Object.keys(raw || {}).find((k) =>
      Array.isArray(raw[k]),
    );
    if (arrayField) {
      console.log(`→ Using field: "${arrayField}"`);
      items = raw[arrayField];
    }
  }

  if (!items) {
    console.warn("⚠ Unknown shape:", Object.keys(raw || {}));
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
      item["Common.PrimaryKey"] || item["Common.ListingId"] || item.id || "";

    const buildSlug = () => {
      const name = (
        item["Common.PropertyName"] ||
        item["Common.BuildingName"] ||
        ""
      )
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
      address:
        `${addr["Common.Line1"] || ""} ${addr["Common.Line2"] || ""}`.trim(),
      city: addr["Common.Locallity"] || addr["Common.Locality"] || "",
      state: addr["Common.Region"] || "",
      zip: addr["Common.PostCode"] || "",
      country: addr["Common.Country"] || "",
      latitude: coord.lat ?? coord.latitude ?? null,
      longitude: coord.lon ?? coord.lng ?? coord.longitude ?? null,
      size: firstSize?.["Common.Size"] || 0,
      sizeUnit: firstSize?.["Common.Units"] || "sqft",
      propertyType:
        item["Common.UsageType"] || item["Common.PropertyType"] || "",
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function fetchCBREListings(filter = DEFAULT_FILTER) {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await setupPage(browser);

    const raw = await fetchListings(page, filter);
    console.log("→ Keys:", Object.keys(raw || {}).join(", "));

    if (raw?.TotalCount !== undefined) {
      console.log(`→ Total: ${raw.TotalCount}`);
    }

    const listings = cleanListings(raw);

    return {
      totalCount: raw?.TotalCount ?? raw?.totalCount ?? listings.length,
      page: filter.page,
      pageSize: filter.pageSize,
      listings,
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// ─── Parse ────────────────────────────────────────────────────────────────────

function parseFilter(query = {}, body = {}) {
  const src = Object.keys(body).length ? body : query;
  const filter = { ...DEFAULT_FILTER };

  if (src.location) filter.location = src.location;

  if (src.types || src.propertyTypes) {
    const raw = src.types || src.propertyTypes;
    filter.propertyTypes = Array.isArray(raw)
      ? raw
      : String(raw)
          .split(",")
          .map((s) => s.trim());
  }

  if (src.polygon) {
    try {
      filter.polygon =
        typeof src.polygon === "string" ? JSON.parse(src.polygon) : src.polygon;
    } catch {}
  }

  if (src.page) filter.page = parseInt(src.page, 10) || 1;
  if (src.pageSize)
    filter.pageSize = Math.min(parseInt(src.pageSize, 10) || 1000, 5000);

  return filter;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({
    status: "CBRE scraper running",
    endpoints: {
      "GET /cbre": "Default Dallas Downtown",
      "GET /cbre?types=Office&page=1": "Custom params",
      "POST /cbre": "JSON body filter",
      "GET /health": "Chrome check",
    },
    defaultFilter: DEFAULT_FILTER,
  });
});

app.get("/health", async (req, res) => {
  try {
    const chromePath = await ensureChrome();
    res.json({
      status: "ok",
      chrome: chromePath,
      exists: existsSync(chromePath),
    });
  } catch (err) {
    res.status(500).json({ status: "error", error: err.message });
  }
});

app.get("/cbre", async (req, res) => {
  console.log("\n=== GET /cbre ===");
  const filter = parseFilter(req.query);
  console.log("Filter:", JSON.stringify(filter, null, 2));

  try {
    const result = await fetchCBREListings(filter);
    console.log(`✓ ${result.listings.length} listings\n`);

    res.json({
      success: true,
      totalCount: result.totalCount,
      page: result.page,
      pageSize: result.pageSize,
      returned: result.listings.length,
      data: result.listings,
    });
  } catch (err) {
    console.error("✗", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/cbre", async (req, res) => {
  console.log("\n=== POST /cbre ===");
  const filter = parseFilter({}, req.body);
  console.log("Filter:", JSON.stringify(filter, null, 2));

  try {
    const result = await fetchCBREListings(filter);
    console.log(`✓ ${result.listings.length} listings\n`);

    res.json({
      success: true,
      totalCount: result.totalCount,
      page: result.page,
      pageSize: result.pageSize,
      returned: result.listings.length,
      data: result.listings,
    });
  } catch (err) {
    console.error("✗", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`\n🚀 Server: http://localhost:${PORT}`);
  console.log(`   Listings: http://localhost:${PORT}/cbre\n`);

  try {
    const chromePath = await ensureChrome();
    console.log(`✓ Chrome ready: ${chromePath}\n`);
  } catch (err) {
    console.error(`✗ Chrome setup failed: ${err.message}\n`);
    console.error("   Try: npm run build\n");
  }
});
