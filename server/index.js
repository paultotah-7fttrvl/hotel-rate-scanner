const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "..")));

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
    const providers = rates.map((r) => ({
      name: r.name,
      rate: r.rate,
      tax: r.tax || 0,
      total: r.rate + (r.tax || 0),
    })).sort((a, b) => a.rate - b.rate);

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
  res.json({ status: "ok", source: "Xotelo (free, no key required)", cacheSize: Object.keys(rateCache).length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Hotel Scanner server running at http://localhost:${PORT}`);
  console.log("Rate source: Xotelo API (Booking.com, Expedia, Agoda, etc.)");
  console.log("No API key required.");
});
