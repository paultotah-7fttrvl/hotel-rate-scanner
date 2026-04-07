const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "..")));

// ─── HOTEL DATA ───────────────────────────────────────────────────────────────
const rawHotels = require("./hotels.json");
const HOTELS = rawHotels.map((h, i) => ({
  ...h,
  id: `h-${i}`,
  variance: 0.25 + (i % 7) * 0.03,
}));

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

// ─── RATE ENDPOINT (Xotelo) ───────────────────────────────────────────────────
const XOTELO_BASE = "https://data.xotelo.com/api";
const rateCache = {};

app.get("/api/rates", async (req, res) => {
  const { hotel_key, chk_in, chk_out } = req.query;

  if (!hotel_key || !chk_in || !chk_out) {
    return res.status(400).json({ error: "Missing required params: hotel_key, chk_in, chk_out" });
  }

  const cacheKey = `${hotel_key}|${chk_in}|${chk_out}`;
  if (rateCache[cacheKey]) {
    console.log(`[Cache] HIT ${hotel_key} ${chk_in}-${chk_out}`);
    return res.json(rateCache[cacheKey]);
  }

  try {
    const url = `${XOTELO_BASE}/rates?hotel_key=${encodeURIComponent(hotel_key)}&chk_in=${chk_in}&chk_out=${chk_out}&currency=USD`;
    console.log(`[API] Fetching rates for ${hotel_key} | ${chk_in} to ${chk_out}`);

    const response = await fetch(url);
    const data = await response.json();

    if (data.error) {
      console.error("[API] Xotelo error:", data.error);
      return res.json({ rate: null, available: false, error: data.error.message || "Xotelo API error" });
    }

    const rates = data.result?.rates || [];

    if (rates.length === 0) {
      const result = { rate: null, available: false, providers: [] };
      rateCache[cacheKey] = result;
      console.log(`[API] No rates found for ${hotel_key}`);
      return res.json(result);
    }

    const lowestRate = Math.min(...rates.map((r) => r.rate));
    const providers = rates
      .map((r) => ({ name: r.name, rate: r.rate, tax: r.tax || 0, total: r.rate + (r.tax || 0) }))
      .sort((a, b) => a.rate - b.rate);

    const result = {
      rate: lowestRate,
      available: true,
      providers,
      currency: data.result?.currency || "USD",
    };

    rateCache[cacheKey] = result;
    console.log(`[API] ${hotel_key}: $${lowestRate}/night from ${providers[0].name} (${providers.length} providers)`);
    return res.json(result);
  } catch (err) {
    console.error("[Error]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/status", (req, res) => {
  res.json({
    status: "ok",
    source: "Xotelo (free, no key required)",
    hotelCount: HOTELS.length,
    cityCount: new Set(HOTELS.map((h) => h.city)).size,
    cacheSize: Object.keys(rateCache).length,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Hotel Scanner server running at http://localhost:${PORT}`);
  console.log(`Loaded ${HOTELS.length} hotels across ${new Set(HOTELS.map((h) => h.city)).size} cities`);
  console.log("Rate source: Xotelo API (Booking.com, Expedia, Agoda, etc.)");
});
