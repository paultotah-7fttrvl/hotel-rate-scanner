// Sandbox server — reads SERPAPI_KEY from sandbox/.env, falls back to parent .env
// Run: node server.js  (from the sandbox directory)
// Port: 3001 (never conflicts with demo/prod on 3000)
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
if (!process.env.SERPAPI_KEY) {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
}

const fs = require("fs");
const express = require("express");
const app = express();
const SERPAPI_KEY = process.env.SERPAPI_KEY;
const LIVE_DAILY_LIMIT = Number(process.env.LIVE_DAILY_LIMIT || 33);

// ─── STATIC FILES ─────────────────────────────────────────────────────────────
// HTML/JS/CSS are read from disk on each request so UI edits show without restart.
// hero-travel.jpg stays in memory (large, rarely changes; avoids macOS sendfile quirks).
const STATIC_ROUTES = {
  "/":                    { file: "index.html",            type: "text/html" },
  "/index.html":          { file: "index.html",            type: "text/html" },
  "/hotels.js":           { file: "hotels.js",             type: "application/javascript" },
  "/proper-azds.js":      { file: "proper-azds.js",        type: "application/javascript" },
  "/theme-sevenfeet.css": { file: "theme-sevenfeet.css",   type: "text/css" },
};
const STATIC_CACHED = {
  "/hero-travel.jpg": {
    buf: fs.readFileSync(path.join(__dirname, "hero-travel.jpg")),
    type: "image/jpeg",
  },
};
app.use((req, res, next) => {
  const cached = STATIC_CACHED[req.path];
  if (cached) return res.type(cached.type).send(cached.buf);
  const route = STATIC_ROUTES[req.path];
  if (route) {
    try {
      const buf = fs.readFileSync(path.join(__dirname, route.file));
      return res.type(route.type).send(buf);
    } catch (err) {
      return res.status(404).send("Not found");
    }
  }
  next();
});


// ─── BRAND SOURCE MATCHING (for rate extraction) ──────────────────────────────
const BRAND_SOURCES = {
  marriott:    ["marriott", "ritz-carlton", "w hotels", "westin", "sheraton", "st. regis", "jw marriott"],
  hilton:      ["hilton", "waldorf astoria", "conrad", "curio collection"],
  hyatt:       ["hyatt", "world of hyatt", "park hyatt", "grand hyatt", "andaz", "alila"],
  ihg:         ["ihg", "intercontinental", "kimpton", "holiday inn", "crowne plaza"],
  proper:      ["proper", "proper hotel", "proper hotels"],
  fourseasons: ["four seasons"],
  fairmont:    ["fairmont"],
};

const BRAND_HOST_PRIORITY = [
  "properhotel.com",
  "marriott.com", "ritzcarlton.com",
  "hilton.com", "waldorfastoria.com", "conradhotels.com",
  "hyatt.com",
  "ihg.com", "intercontinental.com", "kimptonhotels.com", "holidayinn.com", "crowneplaza.com",
  "fourseasons.com", "fairmont.com",
];

// ─── CURRENCY BY CITY ─────────────────────────────────────────────────────────
const CITY_CURRENCY = {
  london: "GBP", paris: "EUR", barcelona: "EUR", rome: "EUR",
  vienna: "EUR", prague: "EUR", lisbon: "EUR", amsterdam: "EUR",
  budapest: "EUR", tokyo: "JPY", "hong kong": "HKD", bangkok: "THB",
  singapore: "SGD", sydney: "AUD",
};

function getCurrency(cityName) {
  return CITY_CURRENCY[(cityName || "").toLowerCase()] || "USD";
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function extractBestRate(dataObj, nights) {
  const r = obj => obj?.extracted_before_taxes_fees ?? obj?.extracted_lowest ?? null;
  const allPrices = dataObj.prices || [];

  // Strategy 1: brand-direct rate from prices[]
  for (const [, frags] of Object.entries(BRAND_SOURCES)) {
    const brand = allPrices.find(p => p.source && frags.some(f => p.source.toLowerCase().includes(f)));
    if (brand) {
      const rate = r(brand.rate_per_night);
      if (rate) return { rate, total: rate * nights };
    }
  }

  // Strategy 2: median of all prices[]
  if (allPrices.length) {
    const rates = allPrices.map(p => r(p.rate_per_night)).filter(v => v != null && v > 0);
    if (rates.length) {
      const rate = median(rates);
      return { rate, total: rate * nights };
    }
  }

  // Strategy 3: median of featured_prices
  const featured = dataObj.featured_prices || [];
  if (featured.length) {
    const rates = featured
      .map(p => r(p.rate_per_night || p.rooms?.[0]?.rate_per_night))
      .filter(v => v != null && v > 0);
    if (rates.length) {
      const rate = median(rates);
      return { rate, total: rate * nights };
    }
  }

  // Strategy 4: top-level fallback
  const rate = r(dataObj.rate_per_night);
  return { rate, total: rate ? rate * nights : null };
}

// SerpAPI wraps booking links in two Google URL formats:
//   google.com/travel/clk  — organic results, destination in `pcurl` param
//   google.com/aclk        — paid/ad results, destination in `adurl` param
// Brand-direct links (Marriott, Hilton, etc.) almost always come through aclk
// because hotels bid on their own brand. Both formats carry date-prefilled URLs.
function decodeGoogleLink(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (url.includes("google.com/aclk")) {
      const adurl = parsed.searchParams.get("adurl");
      if (!adurl) return null;
      // adurl may itself be a doubleclick redirect — recurse to unwrap fully
      return decodeGoogleLink(decodeURIComponent(adurl));
    }
    if (url.includes("doubleclick.net")) {
      // Destination hotel URL is double-encoded inside the query string
      const raw1 = decodeURIComponent(url);
      const raw2 = decodeURIComponent(raw1);
      const proper = raw2.match(/(https?:\/\/(?:www\.)?properhotel\.com[^\s"<>]+)/i);
      if (proper) return proper[1].split(/[?&]dclid=/)[0];
      const m = raw2.match(/(https?:\/\/(?:www\.)?(?:marriott|ritzcarlton|hilton|waldorfastoria|hyatt|ihg|intercontinental|kimptonhotels|holidayinn|crowneplaza|staybridge|candlewood|booking|expedia|hotels|agoda)\.com[^\s"'<>\n]+)/i);
      return m ? m[1].split(/[?&]dclid=/)[0] : null;
    }
    const pcurl = parsed.searchParams.get("pcurl");
    return pcurl ? decodeURIComponent(pcurl) : url;
  } catch {
    return url;
  }
}

const PREFERRED_OTAS = ["booking.com", "expedia", "hotels.com", "agoda"];

function linkIncludesHost(link, host) {
  if (!link) return false;
  try {
    return new URL(link).hostname.toLowerCase().includes(host);
  } catch {
    return link.toLowerCase().includes(host);
  }
}

// IHG brand-code → brand path segment mapping (used to interpret /redirect? links).
const IHG_BRAND_CODES = {
  "6c": "kimptonhotels", "6d": "kimptonhotels", // Kimpton
  "IC": "intercontinental", "CP": "crowneplaza",
  "HI": "holidayinnexpress", "6I": "holidayinn",
  "HP": "staybridge", "EX": "candlewood",
};

// IHG brand-specific domains → brand path segment used in ihg.com select-roomrate URLs.
const IHG_BRAND_DOMAINS = {
  'intercontinental.com': 'intercontinental',
  'crowneplaza.com':      'crowneplaza',
  'holidayinn.com':       'holidayinn',
  'holidayinnexpress.com':'holidayinnexpress',
  'kimptonhotels.com':    'kimptonhotels',
  'staybridge.com':       'staybridge',
  'candlewood.com':       'candlewood',
  'evenhotels.com':       'evenhotels',
  'avid-hotels.com':      'avidhotels',
};

const KIMPTON_PROPERTY_CODES = {
  "kimpton canary hotel": { propCode: "SABCN", brand: "kimptonhotels", region: "us", locale: "en" },
  "kimpton hotel van zandt": { propCode: "AUSVZ", brand: "kimptonhotels", region: "us", locale: "en" },
  "kimpton alton hotel fisherman's wharf": { propCode: "SFOFW", brand: "kimptonhotels", region: "us", locale: "en" },
};

// Extract IHG brand + property code from any prices[] link — ihg.com or brand-owned domain.
// Returns { brand, region, locale, propCode } or null.
function extractIhgInfo(dataObj) {
  const sources = [...(dataObj.prices || []), ...(dataObj.featured_prices || [])];
  for (const p of sources) {
    const link = decodeGoogleLink(p.link || p.url);
    if (!link) continue;
    console.log(`[IHG extract] decoded link: ${link.slice(0, 120)}`);

    // Pattern 1: ihg.com/{brand}/hotels/{region}/{locale}/{city}/{propCode}/
    const m1 = link.match(/ihg\.com\/([\w-]+)\/hotels\/(\w+)\/(\w+)\/[\w-]+\/([a-z0-9]{3,8})(?:\/|$)/i);
    if (m1) return { brand: m1[1], region: m1[2], locale: m1[3], propCode: m1[4].toUpperCase() };

    // Pattern 2: select-roomrate?...qSlH=PROPCODE on ihg.com
    const m2 = link.match(/ihg\.com\/([\w-]+).*[?&]qSlH=([a-z0-9]{3,8})/i);
    if (m2) return { brand: m2[1], region: 'us', locale: 'en', propCode: m2[2].toUpperCase() };

    // Pattern 3: ihg.com/redirect?...hotelCode=PROPCODE&brandCode=XX
    const m3 = link.match(/ihg\.com\/redirect.*[?&]hotelCode=([a-z0-9]{3,8})/i);
    if (m3) {
      const bcm = link.match(/[?&]brandCode=([^&]+)/i);
      const brand = (bcm && IHG_BRAND_CODES[bcm[1]]) || 'intercontinental';
      return { brand, region: 'us', locale: 'en', propCode: m3[1].toUpperCase() };
    }

    // Pattern 4: brand-specific domain (intercontinental.com, crowneplaza.com, etc.)
    // Prop code is typically the last meaningful path segment (3–8 alphanumeric chars).
    for (const [domain, brand] of Object.entries(IHG_BRAND_DOMAINS)) {
      if (!link.includes(domain)) continue;
      // qSlH param takes priority
      const qslh = link.match(/[?&]qSlH=([a-z0-9]{3,8})/i);
      if (qslh) return { brand, region: 'us', locale: 'en', propCode: qslh[1].toUpperCase() };
      // hotelCode param (redirect-style)
      const hc = link.match(/[?&]hotelCode=([a-z0-9]{3,8})/i);
      if (hc) return { brand, region: 'us', locale: 'en', propCode: hc[1].toUpperCase() };
      // Last path segment before query string that looks like a prop code (3-8 alphanum, no dashes)
      const pathM = link.split('?')[0].match(/\/([a-z0-9]{3,8})(?:\/[^/]*)?$/i);
      if (pathM && !/^(en|us|gb|hotels?|detail|overview|rooms?)$/i.test(pathM[1])) {
        return { brand, region: 'us', locale: 'en', propCode: pathM[1].toUpperCase() };
      }
    }
  }
  return null;
}

// Extract the best booking deep-link from SerpAPI prices[].
// Priority: brand-direct hotel site → major OTA → first decodable link.
function extractBookingUrl(dataObj) {
  const prices = dataObj.prices || [];
  if (!prices.length) return null;

  // Decode all links upfront, drop ones that can't be resolved
  const decoded = prices
    .map(p => ({ source: (p.source || "").toLowerCase(), link: decodeGoogleLink(p.link) }))
    .filter(p => p.link);

  // 1. Brand-owned site by link hostname
  for (const host of BRAND_HOST_PRIORITY) {
    const hit = decoded.find(p => linkIncludesHost(p.link, host));
    if (hit) return hit.link;
  }

  // 2. Brand-direct by SerpAPI source label
  for (const [, frags] of Object.entries(BRAND_SOURCES)) {
    const hit = decoded.find(p => frags.some(f => p.source.includes(f)));
    if (hit) return hit.link;
  }

  // 3. Preferred OTA (dates are pre-filled in the decoded URL)
  for (const ota of PREFERRED_OTAS) {
    const hit = decoded.find(p => p.source.includes(ota));
    if (hit) return hit.link;
  }

  // 4. First available decoded link
  return decoded[0]?.link || null;
}

const ProperAzds = require(path.join(__dirname, "proper-azds.js"));

const PROPER_HOTEL_MAP = [
  { match: "austin", slug: "proper-austin", path: "austin" },
  { match: "downtown la", slug: "proper-downtown-la", path: "downtown-la" },
  { match: "los angeles", slug: "proper-downtown-la", path: "downtown-la" },
  { match: "san francisco", slug: "proper-sf", path: "san-francisco" },
  { match: "santa monica", slug: "proper-santa-monica", path: "santa-monica" },
];

function isProperHotelName(name) {
  return (name || "").toLowerCase().includes("proper");
}

function resolveProperPropertyServer(hotelName, city) {
  const blob = `${hotelName || ""} ${city || ""}`.toLowerCase();
  for (const p of PROPER_HOTEL_MAP) {
    if (blob.includes(p.match)) return { slug: p.slug, path: p.path };
  }
  return null;
}

function extractProperBookingUrlFromPrices(dataObj) {
  if (!dataObj?.prices?.length) return null;
  for (const p of dataObj.prices) {
    const link = decodeGoogleLink(p.link);
    if (link && ProperAzds.hasValidBookingData(link)) return link;
  }
  return null;
}

function buildProperBookingUrlServer(hotelName, city, checkIn, checkOut) {
  const prop = resolveProperPropertyServer(hotelName, city);
  if (!prop) return null;
  return ProperAzds.buildBookingUrl(prop.path, prop.slug, checkIn, checkOut, null);
}

// ─── NORMALIZE SERP HOTEL OBJECT ──────────────────────────────────────────────
function normalizeSerpHotel(p, idx, cityHint) {
  const classMatch = (p.hotel_class || "").match(/(\d)/);
  const stars = classMatch ? parseInt(classMatch[1]) : 3;
  const baseRate =
    p.rate_per_night?.extracted_before_taxes_fees ||
    p.rate_per_night?.extracted_lowest ||
    200;
  return {
    id: `sb-${cityHint.replace(/\s+/g, "-").toLowerCase()}-${idx}`,
    name: p.name,
    city: cityHint,
    region: "",
    stars,
    baseRate,
    url: p.link || "",
    address: p.address || "",
    chain: null,
    property_token: p.property_token || null,
    rating: p.overall_rating || p.rating || null,
    variance: 0.25,
  };
}

// ─── CACHES ───────────────────────────────────────────────────────────────────
const searchCache = {};
const SEARCH_TTL_MS = 10 * 60 * 1000; // 10 min

const rateCache = {};
const RATE_TTL_MS = 30 * 60 * 1000; // 30 min
let liveUsage = { day: new Date().toISOString().slice(0, 10), count: 0 };

function cacheGet(store, key, ttl) {
  const entry = store[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > ttl) { delete store[key]; return null; }
  return entry.data;
}

function cacheSet(store, key, data) {
  store[key] = { data, ts: Date.now() };
}

function demoRate(hotelName, checkin, checkout) {
  const checkInDate = new Date(checkin);
  const checkOutDate = new Date(checkout);
  const nights = Math.max(1, Math.round((checkOutDate - checkInDate) / 86400000));
  const dow = checkInDate.getDay();
  const month = checkInDate.getMonth();
  const charSum = hotelName.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const seed = (charSum * 31 + checkInDate.getDate() * 17 + month * 53 + dow * 7) % 100;
  let multiplier = 1;
  if (dow === 5 || dow === 6) multiplier += 0.15;
  if (dow === 0) multiplier += 0.08;
  if (month >= 5 && month <= 8) multiplier += 0.20;
  if (month === 11) multiplier += 0.18;
  const baseRate = 180 + (charSum % 220);
  const noise = (seed / 100 - 0.5) * 0.3;
  const rate = Math.max(Math.round(baseRate * 0.6), Math.round(baseRate * (multiplier + noise)));
  return { rate, total: rate * nights, nights };
}

function getLiveUsage() {
  const today = new Date().toISOString().slice(0, 10);
  if (liveUsage.day !== today) liveUsage = { day: today, count: 0 };
  return liveUsage;
}

function canUseLiveCall() {
  return getLiveUsage().count < LIVE_DAILY_LIMIT;
}

function recordLiveCall(label) {
  const usage = getLiveUsage();
  usage.count += 1;
  console.log(`[SerpAPI Usage] ${label}: ${usage.count}/${LIVE_DAILY_LIMIT} today`);
  return usage;
}

function demoFallbackResult(hotel, checkin, checkout, nights, currency, reason) {
  const { rate, total } = demoRate(hotel, checkin, checkout);
  return {
    rate,
    source: reason === "daily_limit" ? "demo_daily_limit" : "demo_fallback",
    property_name: hotel,
    check_in: checkin,
    check_out: checkout,
    total,
    nights,
    currency,
    quotaLimited: reason === "daily_limit",
    message: reason === "daily_limit"
      ? "Daily live-rate limit reached. Showing demo rates to protect API usage."
      : undefined,
  };
}

// ─── DISCOVERY DATE HELPERS ───────────────────────────────────────────────────
// google_hotels requires check_in_date + check_out_date on every call, even for
// discovery searches. We pass a fixed 1-night window 14 days out so the engine
// returns live hotel listings without the user needing to pick dates first.
function discoveryDates() {
  const ci = new Date();
  ci.setDate(ci.getDate() + 14);
  const co = new Date(ci);
  co.setDate(co.getDate() + 1);
  const fmt = d => d.toISOString().split("T")[0];
  return { checkIn: fmt(ci), checkOut: fmt(co) };
}

// ─── HOTEL ENDPOINTS ──────────────────────────────────────────────────────────
// Sandbox has no static list — returns empty so the frontend browse panel
// falls back to the curated POPULAR_DESTINATIONS constant in index.html
app.get("/api/hotels", (req, res) => res.json([]));

app.get("/api/hotels/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  const city = (req.query.city || "").trim();
  const excludeSet = new Set((req.query.exclude || "").split(",").filter(Boolean));

  // City browse → "hotels in Paris"
  // Text search  → query as typed ("Park Hyatt Tokyo" or "Paris")
  const searchTerm = city ? `hotels in ${city}` : q || null;
  if (!searchTerm) return res.json([]);

  const cacheKey = searchTerm.toLowerCase();
  const cached = cacheGet(searchCache, cacheKey, SEARCH_TTL_MS);
  if (cached) {
    const filtered = cached.filter(h => !excludeSet.has(h.id));
    console.log(`[Search Cache] HIT "${searchTerm}" → ${filtered.length} results`);
    return res.json(filtered.slice(0, 8));
  }

  if (!SERPAPI_KEY) {
    return res.status(500).json({ error: "SERPAPI_KEY not configured. Add it to sandbox/.env" });
  }

  if (!canUseLiveCall()) {
    return res.status(429).json({
      error: "daily_limit",
      message: "Daily live-search limit reached. Showing curated fallback results to protect API usage.",
    });
  }

  try {
    // google_hotels requires dates even for discovery — use a fixed 1-night window
    const { checkIn, checkOut } = discoveryDates();
    const url = `https://serpapi.com/search.json?engine=google_hotels&q=${encodeURIComponent(searchTerm)}&check_in_date=${checkIn}&check_out_date=${checkOut}&currency=USD&gl=us&hl=en&api_key=${SERPAPI_KEY}`;
    recordLiveCall(`search "${searchTerm}"`);
    console.log(`[SerpAPI Search] "${searchTerm}"`);

    const response = await fetch(url);
    const data = await response.json();

    if (data.error) {
      console.error("[SerpAPI Search Error]", data.error);
      return res.status(500).json({ error: data.error });
    }

    // cityHint: use explicit city param if available, otherwise extract from
    // the last word of the query (e.g. "Park Hyatt Tokyo" → "Tokyo")
    const cityHint = city || (q.split(" ").length > 2 ? q.split(" ").pop() : q);

    let hotels;
    if (data.type === "hotel" && data.name) {
      // SerpAPI found one exact hotel — wrap it as a single-item result
      hotels = [normalizeSerpHotel(data, 0, cityHint)];
    } else {
      hotels = (data.properties || []).map((p, i) => normalizeSerpHotel(p, i, cityHint));
    }
    console.log(`[SerpAPI Search] "${searchTerm}" → ${hotels.length} result(s)`);

    cacheSet(searchCache, cacheKey, hotels);

    const filtered = hotels.filter(h => !excludeSet.has(h.id));
    return res.json(filtered.slice(0, 8));
  } catch (err) {
    console.error("[Search Error]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── RATE ENDPOINT ────────────────────────────────────────────────────────────
app.get("/api/rates", async (req, res) => {
  const { hotel, city, checkin, checkout } = req.query;
  const propertyToken = req.query.propertyToken || null;

  if (!hotel || !city || !checkin || !checkout) {
    return res.status(400).json({ error: "Missing required params: hotel, city, checkin, checkout" });
  }

  const nights = Math.max(1, Math.round((new Date(checkout) - new Date(checkin)) / 86400000));
  // Include propertyToken in cache key so token-based lookups don't collide with name-based ones
  const cacheKey = propertyToken
    ? `pt:${propertyToken}|${checkin}|${checkout}`
    : `${hotel}|${city}|${checkin}|${checkout}`;
  const currency = getCurrency(city);
  const bust = req.query.bust === '1';

  if (!bust) {
    const cached = cacheGet(rateCache, cacheKey, RATE_TTL_MS);
    if (cached) {
      console.log(`[Rate Cache] HIT ${hotel}`);
      return res.json(cached);
    }
  }

  if (!SERPAPI_KEY) {
    return res.status(500).json({ error: "SERPAPI_KEY not configured" });
  }

  if (!canUseLiveCall()) {
    const result = demoFallbackResult(hotel, checkin, checkout, nights, currency, "daily_limit");
    cacheSet(rateCache, cacheKey, result);
    return res.json(result);
  }

  try {
    const nameUrl = `https://serpapi.com/search.json?engine=google_hotels&q=${encodeURIComponent(`${hotel} ${city}`)}&check_in_date=${checkin}&check_out_date=${checkout}&currency=${currency}&gl=us&hl=en&api_key=${SERPAPI_KEY}`;
    const tokenUrl = propertyToken
      ? `https://serpapi.com/search.json?engine=google_hotels&property_token=${encodeURIComponent(propertyToken)}&check_in_date=${checkin}&check_out_date=${checkout}&currency=${currency}&gl=us&hl=en&api_key=${SERPAPI_KEY}`
      : null;

    recordLiveCall(`rate "${hotel}"`);
    console.log(`[SerpAPI Rate] "${hotel}", ${city} | ${checkin} → ${checkout}${tokenUrl ? " (token)" : ""}`);

    const response = await fetch(tokenUrl || nameUrl);
    let data = await response.json();

    // If token call returned no rate data, fall back to name+city search
    if (tokenUrl && !data.error && !data.rate_per_night && !(data.properties || []).length) {
      if (!canUseLiveCall()) {
        const result = demoFallbackResult(hotel, checkin, checkout, nights, currency, "daily_limit");
        cacheSet(rateCache, cacheKey, result);
        return res.json(result);
      }
      console.log(`[SerpAPI Rate] Token returned empty — falling back to name+city search`);
      recordLiveCall(`rate fallback "${hotel}"`);
      const fallback = await fetch(nameUrl);
      data = await fallback.json();
    }

    if (data.error) {
      console.error("[SerpAPI Rate Error]", data.error);
      const result = demoFallbackResult(hotel, checkin, checkout, nights, currency);
      return res.json(result);
    }

    let rate = null, total = null, matchName = hotel, bookingUrl = null, ihgInfo = null;
    let rateSource = data;

    if (data.type === "hotel" && data.rate_per_night) {
      ({ rate, total } = extractBestRate(data, nights));
      bookingUrl = extractBookingUrl(data);
      ihgInfo = extractIhgInfo(data);
      matchName = data.name || hotel;
      console.log(`[SerpAPI Rate] Direct match: "${matchName}" $${rate}/night`);
    } else {
      const properties = data.properties || [];
      if (properties.length === 0) {
        const result = { rate: null, source: "live", property_name: hotel, check_in: checkin, check_out: checkout, total: null, nights, currency, error: "no_results" };
        cacheSet(rateCache, cacheKey, result);
        return res.json(result);
      }

      const hotelLower = hotel.toLowerCase();
      const match = properties.find(p =>
        p.name && (
          p.name.toLowerCase() === hotelLower ||
          p.name.toLowerCase().includes(hotelLower.split(" ").slice(-1)[0]) ||
          hotelLower.includes(p.name.toLowerCase().split(" ").slice(-1)[0])
        )
      ) || properties[0];

      ({ rate, total } = extractBestRate(match, nights));
      bookingUrl = extractBookingUrl(match);
      ihgInfo = extractIhgInfo(match);
      matchName = match.name || hotel;
      rateSource = match;
      console.log(`[SerpAPI Rate] Best match: "${matchName}" $${rate}/night`);
    }

    if (ihgInfo) console.log(`[SerpAPI Rate] IHG info: brand=${ihgInfo.brand} propCode=${ihgInfo.propCode}`);

    if (isProperHotelName(hotel) || isProperHotelName(matchName)) {
      const built = buildProperBookingUrlServer(matchName, city, checkin, checkout);
      if (built) {
        bookingUrl = built;
        console.log(`[Proper] booking URL → ${bookingUrl.includes("step-2") ? "step-2 (dates)" : "step-1 (pick dates)"}`);
      }
    }

    const result = {
      rate,
      source: "live",
      property_name: matchName,
      check_in: checkin,
      check_out: checkout,
      total: total || (rate ? rate * nights : null),
      nights,
      currency,
      booking_url: bookingUrl,
      ...(ihgInfo && {
        ihg_brand: ihgInfo.brand,
        ihg_region: ihgInfo.region,
        ihg_locale: ihgInfo.locale,
        ihg_prop_code: ihgInfo.propCode,
      }),
    };

    cacheSet(rateCache, cacheKey, result);
    return res.json(result);
  } catch (err) {
    console.error("[Rate Error]", err.message);
    return res.json(demoFallbackResult(hotel, checkin, checkout, nights, currency));
  }
});

// ─── KIMPTON PROPERTY CODE LOOKUP ────────────────────────────────────────────
// Fetches the Kimpton property's own website and extracts the IHG property code
// from booking links embedded in the page. Cached permanently per URL (codes don't change).
const kimptonCodeCache = {};

app.get("/api/kimpton-propcode", async (req, res) => {
  const rawUrl = (req.query.url || "").trim();
  const hotelName = (req.query.name || "").trim().toLowerCase();
  const known = KIMPTON_PROPERTY_CODES[hotelName];
  if (known) return res.json(known);
  if (!rawUrl) return res.json({ propCode: null });

  const cacheKey = rawUrl.split("?")[0];
  if (kimptonCodeCache[cacheKey] !== undefined) {
    console.log(`[Kimpton Code] Cache HIT ${cacheKey} → ${kimptonCodeCache[cacheKey]?.propCode}`);
    return res.json(kimptonCodeCache[cacheKey]);
  }

  try {
    const resp = await fetch(rawUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });

    // If the URL itself redirected to an IHG property page, extract code from final URL
    const finalUrl = resp.url || "";
    const urlMatch = finalUrl.match(/ihg\.com\/([\w-]+)\/hotels\/(\w+)\/(\w+)\/[\w-]+\/([a-z0-9]{3,8})\//i);
    if (urlMatch) {
      const result = { propCode: urlMatch[4].toUpperCase(), brand: urlMatch[1], region: urlMatch[2], locale: urlMatch[3] };
      kimptonCodeCache[cacheKey] = result;
      console.log(`[Kimpton Code] Redirect hit → ${result.propCode}`);
      return res.json(result);
    }

    const html = await resp.text();

    // Scan page HTML for IHG hotel detail or booking links
    const patterns = [
      // /brand/hotels/region/locale/city/PROPCODE/
      /ihg\.com\/([\w-]+)\/hotels\/(\w+)\/(\w+)\/[\w-]+\/([a-z0-9]{3,8})\//i,
      // select-roomrate?...qSlH=PROPCODE
      /ihg\.com\/([\w-]+)[^"']*[?&]qSlH=([a-z0-9]{3,8})/i,
      // /redirect?...hotelCode=PROPCODE
      /ihg\.com\/redirect[^"']*[?&]hotelCode=([a-z0-9]{3,8})/i,
    ];

    for (const pat of patterns) {
      const m = html.match(pat);
      if (!m) continue;
      let result;
      if (pat.source.includes("qSlH")) {
        result = { propCode: m[2].toUpperCase(), brand: m[1], region: "us", locale: "en" };
      } else if (pat.source.includes("hotelCode")) {
        result = { propCode: m[1].toUpperCase(), brand: "kimptonhotels", region: "us", locale: "en" };
      } else {
        result = { propCode: m[4].toUpperCase(), brand: m[1], region: m[2], locale: m[3] };
      }
      kimptonCodeCache[cacheKey] = result;
      console.log(`[Kimpton Code] Scraped ${cacheKey} → ${result.propCode}`);
      return res.json(result);
    }

    console.log(`[Kimpton Code] No prop code found for ${cacheKey}`);
    kimptonCodeCache[cacheKey] = { propCode: null };
    return res.json({ propCode: null });
  } catch (err) {
    console.error("[Kimpton Code Error]", err.message);
    return res.json({ propCode: null });
  }
});

// ─── STATUS ───────────────────────────────────────────────────────────────────
app.get("/api/status", (req, res) => {
  res.json({
    status: "ok",
    mode: "sandbox-live",
    serpApiConfigured: !!SERPAPI_KEY,
    searchCacheSize: Object.keys(searchCache).length,
    rateCacheSize: Object.keys(rateCache).length,
    liveUsage: getLiveUsage(),
    liveDailyLimit: LIVE_DAILY_LIMIT,
  });
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n  Hotel Rate Scanner — SANDBOX`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Mode: live SerpAPI | any hotel, anywhere`);
  console.log(`  SerpAPI: ${SERPAPI_KEY ? "configured ✓" : "NOT SET ✗  →  add SERPAPI_KEY to sandbox/.env"}\n`);
});
