require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
const SERPAPI_KEY = process.env.SERPAPI_KEY;
const RATE_MODE = process.env.RATE_MODE || "demo";

app.use(express.static(path.join(__dirname, "..", "public")));

// ─── HOTEL DATA ───────────────────────────────────────────────────────────────
const rawHotels = require("./hotels.json");
const HOTELS = rawHotels.map((h, i) => ({
  ...h,
  id: `h-${i}`,
  variance: 0.25 + (i % 7) * 0.03,
}));

// ─── BRAND SOURCE MATCHING ────────────────────────────────────────────────────
const BRAND_SOURCES = {
  marriott:    ['marriott', 'ritz-carlton', 'w hotels', 'westin', 'sheraton', 'st. regis', 'jw marriott'],
  hilton:      ['hilton', 'waldorf astoria', 'conrad', 'curio collection'],
  hyatt:       ['hyatt', 'world of hyatt', 'park hyatt', 'grand hyatt', 'andaz', 'alila'],
  ihg:         ['ihg', 'intercontinental', 'kimpton', 'holiday inn', 'crowne plaza'],
  fourseasons: ['four seasons'],
  fairmont:    ['fairmont'],
  aka:         ['aka hotels', 'aka'],
  sirhotels:   ['sir hotels', 'sirhotels'],
  synxis:      ['raphael', 'hotelraphael'],
};

// ─── CURRENCY BY CITY ─────────────────────────────────────────────────────────
const CITY_CURRENCY = {
  'london': 'GBP', 'limerick': 'EUR', 'paris': 'EUR', 'barcelona': 'EUR',
  'rome': 'EUR', 'vienna': 'EUR', 'prague': 'EUR', 'lisbon': 'EUR',
  'amsterdam': 'EUR', 'budapest': 'EUR', 'tokyo': 'JPY', 'hong kong': 'HKD',
  'bangkok': 'THB', 'singapore': 'SGD', 'sydney': 'AUD',
};

function getCurrency(hotelObj) {
  return CITY_CURRENCY[(hotelObj?.city || '').toLowerCase()] || 'USD';
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function extractBestRate(dataObj, hotelChain, nights) {
  const r = obj => obj?.extracted_before_taxes_fees ?? obj?.extracted_lowest ?? null;
  const allPrices = dataObj.prices || [];

  // Strategy 1: brand.com from prices[]
  if (allPrices.length && hotelChain && BRAND_SOURCES[hotelChain]) {
    const frags = BRAND_SOURCES[hotelChain];
    const brand = allPrices.find(p => p.source && frags.some(f => p.source.toLowerCase().includes(f)));
    if (brand) {
      const rate = r(brand.rate_per_night);
      if (rate) {
        console.log(`[Rate] Strategy 1 — Brand direct (${brand.source}): $${rate}`);
        return { rate, total: rate * nights };
      }
    }
  }

  // Strategy 2: median of all prices[]
  if (allPrices.length) {
    const rates = allPrices.map(p => r(p.rate_per_night)).filter(v => v != null && v > 0);
    if (rates.length) {
      const rate = median(rates);
      console.log(`[Rate] Strategy 2 — Median of prices[] (${rates.length} sources): $${rate}`);
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
      console.log(`[Rate] Strategy 3 — Median of featured_prices (${rates.length} sources): $${rate}`);
      return { rate, total: rate * nights };
    }
  }

  // Strategy 4: top-level fallback
  const rate = r(dataObj.rate_per_night);
  console.log(`[Rate] Strategy 4 — Fallback top-level: $${rate}`);
  return { rate, total: rate ? rate * nights : null };
}

function scoreHotel(hotel, q) {
  const n = hotel.name.toLowerCase();
  const c = hotel.city.toLowerCase();
  const r = hotel.region.toLowerCase();
  if (n === q) return 100;
  if (n.startsWith(q)) return 80;
  if (n.includes(q)) return 60;
  if (c === q) return 40;
  if (c.startsWith(q)) return 35;
  if (c.includes(q)) return 30;
  if (r.includes(q)) return 15;
  return 0;
}

// ─── HOTEL ENDPOINTS ──────────────────────────────────────────────────────────
app.get("/api/hotels", (req, res) => {
  res.json(HOTELS);
});

app.get("/api/hotels/search", (req, res) => {
  const q = (req.query.q || "").toLowerCase().trim();
  const excludeSet = new Set((req.query.exclude || "").split(",").filter(Boolean));
  const city = (req.query.city || "").trim();

  let pool = HOTELS.filter((h) => !excludeSet.has(h.id));

  if (city) {
    pool = pool
      .filter((h) => h.city.toLowerCase() === city.toLowerCase())
      .sort((a, b) => b.stars - a.stars);
    return res.json(pool);
  }

  if (!q) {
    return res.json(pool.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 8));
  }

  const results = pool
    .map((h) => ({ hotel: h, score: scoreHotel(h, q) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ hotel }) => hotel);

  res.json(results);
});

// ─── DEMO RATE ENGINE ────────────────────────────────────────────────────────
function demoRate(hotelName, checkin, checkout) {
  const checkInDate = new Date(checkin);
  const checkOutDate = new Date(checkout);
  const nights = Math.max(1, Math.round((checkOutDate - checkInDate) / 86400000));
  const dow = checkInDate.getDay();
  const month = checkInDate.getMonth();
  const charSum = hotelName.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const seed = (charSum * 31 + checkInDate.getDate() * 17 + month * 53 + dow * 7) % 100;
  const hotel = HOTELS.find((h) => h.name === hotelName) || { baseRate: 200, variance: 0.3 };
  let multiplier = 1;
  if (dow === 5 || dow === 6) multiplier += 0.15;
  if (dow === 0) multiplier += 0.08;
  if (month >= 5 && month <= 8) multiplier += 0.20;
  if (month === 11) multiplier += 0.18;
  const noise = (seed / 100 - 0.5) * (hotel.variance || 0.3);
  const rate = Math.max(Math.round(hotel.baseRate * 0.6), Math.round(hotel.baseRate * (multiplier + noise)));
  return { rate, total: rate * nights, nights };
}

// ─── RATE CACHE (in-memory, 30-min TTL) ──────────────────────────────────────
const rateCache = {};
const CACHE_TTL_MS = 30 * 60 * 1000;

function cacheGet(key) {
  const entry = rateCache[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { delete rateCache[key]; return null; }
  return entry.data;
}

function cacheSet(key, data) {
  rateCache[key] = { data, ts: Date.now() };
}

// ─── RATE ENDPOINT ────────────────────────────────────────────────────────────
app.get("/api/rates", async (req, res) => {
  const { hotel, city, checkin, checkout } = req.query;

  if (!hotel || !city || !checkin || !checkout) {
    return res.status(400).json({ error: "Missing required params: hotel, city, checkin, checkout" });
  }

  const nights = Math.max(1, Math.round((new Date(checkout) - new Date(checkin)) / 86400000));
  const cacheKey = `${hotel}|${city}|${checkin}|${checkout}`;

  const hotelData = HOTELS.find(h => h.name === hotel);
  const currency = getCurrency(hotelData);
  const hotelChain = hotelData?.chain;

  // Demo mode — no SerpAPI call
  if (RATE_MODE !== "live") {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    const { rate, total } = demoRate(hotel, checkin, checkout);
    const result = { rate, source: "demo", property_name: hotel, check_in: checkin, check_out: checkout, total, nights, currency };
    cacheSet(cacheKey, result);
    return res.json(result);
  }

  // Live mode — SerpAPI Google Hotels
  const cached = cacheGet(cacheKey);
  if (cached) {
    console.log(`[Cache] HIT ${hotel} ${checkin}-${checkout}`);
    return res.json(cached);
  }

  try {
    const q = encodeURIComponent(`${hotel} ${city}`);
    const url = `https://serpapi.com/search.json?engine=google_hotels&q=${q}&check_in_date=${checkin}&check_out_date=${checkout}&currency=${currency}&gl=us&hl=en&api_key=${SERPAPI_KEY}`;
    console.log(`[SerpAPI] ${hotel}, ${city} | ${checkin} → ${checkout}`);

    const response = await fetch(url);
    const data = await response.json();

    if (data.error) {
      console.error("[SerpAPI] Error:", data.error);
      const { rate, total } = demoRate(hotel, checkin, checkout);
      const result = { rate, source: "demo_fallback", property_name: hotel, check_in: checkin, check_out: checkout, total, nights, currency };
      return res.json(result);
    }

    let rate = null;
    let total = null;
    let matchName = hotel;

    if (data.type === "hotel" && data.rate_per_night) {
      ({ rate, total } = extractBestRate(data, hotelChain, nights));
      matchName = data.name || hotel;
    } else {
      const properties = data.properties || [];

      if (properties.length === 0) {
        const result = { rate: null, source: "live", property_name: hotel, check_in: checkin, check_out: checkout, total: null, nights, currency, error: "no_results" };
        cacheSet(cacheKey, result);
        return res.json(result);
      }

      const hotelLower = hotel.toLowerCase();
      const match = properties.find((p) =>
        p.name && (
          p.name.toLowerCase() === hotelLower ||
          p.name.toLowerCase().includes(hotelLower.split(" ").slice(-1)[0]) ||
          hotelLower.includes(p.name.toLowerCase().split(" ").slice(-1)[0])
        )
      ) || properties[0];

      ({ rate, total } = extractBestRate(match, hotelChain, nights));
      matchName = match.name || hotel;
    }

    if (!rate) {
      const result = { rate: null, source: "live", property_name: matchName, check_in: checkin, check_out: checkout, total: null, nights, currency, error: "no_results" };
      cacheSet(cacheKey, result);
      return res.json(result);
    }

    const result = { rate, source: "live", property_name: matchName, check_in: checkin, check_out: checkout, total, nights, currency };
    cacheSet(cacheKey, result);
    return res.json(result);

  } catch (err) {
    console.error("[Error]", err.message);
    const { rate, total } = demoRate(hotel, checkin, checkout);
    return res.json({ rate, source: "demo_fallback", property_name: hotel, check_in: checkin, check_out: checkout, total, nights, currency });
  }
});

app.get("/api/status", (req, res) => {
  res.json({
    status: "ok",
    mode: RATE_MODE,
    hotelCount: HOTELS.length,
    cityCount: new Set(HOTELS.map((h) => h.city)).size,
    cacheSize: Object.keys(rateCache).length,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Hotel Scanner running at http://localhost:${PORT}`);
  console.log(`Rate mode: ${RATE_MODE.toUpperCase()} | ${HOTELS.length} hotels · ${new Set(HOTELS.map((h) => h.city)).size} cities`);
});
