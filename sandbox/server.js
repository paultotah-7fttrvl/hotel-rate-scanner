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
const Currency = require(path.join(__dirname, "..", "currency-display.js"));
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
  marriott:    ["marriott", "ritz-carlton", "w hotels", "westin", "sheraton", "st. regis", "jw marriott", "citizenm", "citizen m"],
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

function isBrandBookingHost(host) {
  return BRAND_HOST_PRIORITY.some(
    (h) => host === h || (host && host.includes(h.replace(".com", "")))
  );
}

// ─── CURRENCY / LOCALE ────────────────────────────────────────────────────────
const CITY_CURRENCY = {
  london: "GBP", dublin: "EUR", paris: "EUR", barcelona: "EUR", rome: "EUR",
  vienna: "EUR", prague: "EUR", lisbon: "EUR", amsterdam: "EUR",
  budapest: "EUR", tokyo: "JPY", "hong kong": "HKD", bangkok: "THB",
  singapore: "SGD", sydney: "AUD", miami: "USD", "new york": "USD",
  "los angeles": "USD", chicago: "USD", boston: "USD",
};

const COUNTRY_CURRENCY = {
  ireland: "EUR", uk: "GBP", "united kingdom": "GBP", england: "GBP",
  scotland: "GBP", france: "EUR", germany: "EUR", italy: "EUR", spain: "EUR",
  portugal: "EUR", netherlands: "EUR", austria: "EUR", japan: "JPY",
  australia: "AUD", mexico: "MXN", canada: "CAD",
};

const CURRENCY_GL = {
  EUR: "ie", GBP: "uk", USD: "us", JPY: "jp", AUD: "au", CAD: "ca", MXN: "mx",
};

function cityFromAddress(address) {
  if (!address) return null;
  const parts = address.split(",").map(s => s.trim()).filter(Boolean);
  if (/ireland/i.test(address)) {
    for (const part of parts) {
      const c = part.toLowerCase();
      if (CITY_CURRENCY[c]) return part;
      if (/^dublin$/i.test(part)) return "Dublin";
    }
  }
  if (/united kingdom| england| scotland| wales/i.test(address)) {
    for (const part of parts) {
      const key = part.toLowerCase();
      if (CITY_CURRENCY[key]) return part;
    }
  }
  return null;
}

function resolveCurrency(cityName, address, hotelName) {
  const blob = `${cityName || ""} ${address || ""} ${hotelName || ""}`.toLowerCase();
  for (const [country, cur] of Object.entries(COUNTRY_CURRENCY)) {
    if (blob.includes(country)) return cur;
  }
  const fromAddr = cityFromAddress(address);
  if (fromAddr && CITY_CURRENCY[fromAddr.toLowerCase()]) {
    return CITY_CURRENCY[fromAddr.toLowerCase()];
  }
  const city = (cityName || "").toLowerCase().trim();
  if (CITY_CURRENCY[city]) return CITY_CURRENCY[city];
  for (const [name, cur] of Object.entries(CITY_CURRENCY)) {
    if (city && (city.includes(name) || name.includes(city))) return cur;
  }
  return "USD";
}

function googleHotelsLocale(currency) {
  const cur = currency || "USD";
  return { currency: cur, gl: CURRENCY_GL[cur] || "us" };
}

function getCurrency(cityName) {
  return resolveCurrency(cityName, null, null);
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// ─── RATE VALIDATION (SerpAPI) ────────────────────────────────────────────────
const HOTEL_MATCH_MIN_SCORE = 0.52;
const RATE_AGREE_MIN = 0.70;
const RATE_AGREE_MAX = 1.40;
const RATE_MAX_SPREAD = 2.6;
const RATE_DISCLAIMER = "Rates may or may not include resort or hotel fees. Taxes are not included.";
const RATE_UNVERIFIED_MESSAGE =
  "Unable to retrieve rates. Check the hotel site for availability.";
const CITIZEN_M_NO_RATE_MESSAGE = RATE_UNVERIFIED_MESSAGE;
/** Non-official brand row must be within this fraction of headline to be shown. */
const BRAND_HEADLINE_MAX_DIFF = 0.22;
/** Reject official brand rate only when it is this much above headline (bad member/package noise). */
const BRAND_OFFICIAL_MAX_ABOVE_HEADLINE = 0.45;

const BRAND_HOST_LABELS = {
  "marriott.com": "Marriott",
  "ritzcarlton.com": "Ritz-Carlton",
  "hilton.com": "Hilton",
  "waldorfastoria.com": "Waldorf Astoria",
  "conradhotels.com": "Conrad",
  "hyatt.com": "Hyatt",
  "ihg.com": "IHG",
  "intercontinental.com": "InterContinental",
  "kimptonhotels.com": "Kimpton",
  "holidayinn.com": "Holiday Inn",
  "crowneplaza.com": "Crowne Plaza",
  "fourseasons.com": "Four Seasons",
  "fairmont.com": "Fairmont",
  "aguacalientecasinos.com": "Agua Caliente",
};

function brandLabelFromHost(host) {
  return BRAND_HOST_LABELS[host] || host.replace(".com", "").replace(/^\w/, c => c.toUpperCase());
}

function sanitizeRateSourceLabel(label) {
  if (!label || /google/i.test(label)) return null;
  return label;
}

const OTA_HOST_LABELS = {
  "booking.com": "Booking.com",
  "expedia.com": "Expedia",
  "hotels.com": "Hotels.com",
  "agoda.com": "Agoda",
};

/** Official hotel sites where the hostname is a property brand, not a booking platform name. */
const HOTEL_WEBSITE_HOSTS = new Set([
  "fourseasons.com",
  "fairmont.com",
]);

const BOOKING_PROVIDER_SOURCE_FRAGMENTS = [
  "marriott", "hilton", "hyatt", "ihg", "expedia", "booking.com", "booking",
  "hotels.com", "agoda", "intercontinental", "kimpton", "holiday inn",
  "crowne plaza", "ritz", "waldorf", "conrad", "four seasons", "fairmont",
  "agua caliente", "w hotels", "westin", "sheraton", "st. regis", "andaz",
];

function hostFromBookingLink(link) {
  if (!link) return null;
  try {
    return new URL(link).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function normalizeSourceForCompare(text) {
  return (text || "")
    .toLowerCase()
    .replace(/\.com$/i, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeHotelOrPropertyName(serpSource, propertyName, hotelName) {
  const src = normalizeSourceForCompare(serpSource);
  if (!src) return true;
  if (BOOKING_PROVIDER_SOURCE_FRAGMENTS.some((frag) => src.includes(frag))) return false;
  for (const name of [propertyName, hotelName]) {
    const n = normalizeSourceForCompare(name);
    if (!n) continue;
    if (src === n || n.includes(src) || src.includes(n)) return true;
  }
  if (/\b(proper|shelborne)\b/.test(src)) return true;
  return false;
}

/**
 * Booking source should reflect the provider behind the selected offer/Book link,
 * not the hotel brand or property name.
 */
function bookingSourceLabelFromOffer({ host, link, serpSource, propertyName, hotelName }) {
  const resolvedHost = (host || hostFromBookingLink(link) || "").toLowerCase();

  if (resolvedHost === "properhotel.com") return "Proper Hotels";
  if (HOTEL_WEBSITE_HOSTS.has(resolvedHost)) return "Hotel website";

  if (BRAND_HOST_LABELS[resolvedHost]) return BRAND_HOST_LABELS[resolvedHost];
  if (OTA_HOST_LABELS[resolvedHost]) return OTA_HOST_LABELS[resolvedHost];

  for (const [otaHost, label] of Object.entries(OTA_HOST_LABELS)) {
    if (resolvedHost === otaHost || resolvedHost.endsWith("." + otaHost)) return label;
  }
  for (const [brandHost, label] of Object.entries(BRAND_HOST_LABELS)) {
    if (resolvedHost === brandHost || resolvedHost.includes(brandHost.replace(".com", ""))) {
      return label;
    }
  }

  if (
    serpSource &&
    !looksLikeHotelOrPropertyName(serpSource, propertyName, hotelName)
  ) {
    const cleaned = serpSource.replace(/\.com$/i, "").trim();
    if (cleaned && !/google/i.test(cleaned)) return cleaned;
  }

  if (resolvedHost && isBrandBookingHost(resolvedHost)) return "Hotel website";
  if (resolvedHost) return "Booking site";
  return "View offer";
}

function rateSourceLabelForBookingUrl(bookingUrl, fallbackLabel, propertyName, hotelName) {
  const label = bookingSourceLabelFromOffer({
    link: bookingUrl,
    serpSource: fallbackLabel,
    propertyName,
    hotelName,
  });
  return sanitizeRateSourceLabel(label) || sanitizeRateSourceLabel(fallbackLabel);
}

function priceRowSourceLabel(p, dataObj, hostOverride) {
  const link = decodeGoogleLink(p.link || p.url, p.source || "");
  let host = hostOverride || null;
  if (!host && link) {
    for (const h of BRAND_HOST_PRIORITY) {
      if (linkIncludesHost(link, h)) { host = h; break; }
    }
    if (!host) {
      for (const ota of PREFERRED_OTAS) {
        if (linkIncludesHost(link, ota)) { host = ota; break; }
      }
    }
    if (!host) host = hostFromBookingLink(link);
  }
  return bookingSourceLabelFromOffer({
    host,
    link,
    serpSource: p.source,
    propertyName: dataObj?.name,
  });
}

/** Headline / OTA — prefer modest "lowest" when it reflects bundled taxes/fees. */
function publicDisplayRate(rateObj) {
  if (!rateObj) return null;
  const before = rateObj.extracted_before_taxes_fees;
  const lowest = rateObj.extracted_lowest;
  if (before == null && lowest == null) return null;
  if (before == null) return Math.round(lowest);
  if (lowest == null) return Math.round(before);
  if (lowest >= before && lowest <= before * 1.28) return Math.round(lowest);
  return Math.round(before);
}

/** Brand.com rows — match hyatt.com/hilton.com "before taxes" nightly, not tax-inclusive lowest. */
function brandDisplayRate(rateObj) {
  if (!rateObj) return null;
  const before = rateObj.extracted_before_taxes_fees;
  const lowest = rateObj.extracted_lowest;
  if (before != null) return Math.round(before);
  if (lowest != null) return Math.round(lowest);
  return null;
}

function nightRateValue(rateObj) {
  return publicDisplayRate(rateObj);
}

function collectRateCandidates(dataObj) {
  const rates = [];
  const add = (v) => { if (v != null && v > 0) rates.push(v); };
  add(nightRateValue(dataObj.rate_per_night));
  for (const p of dataObj.prices || []) add(nightRateValue(p.rate_per_night));
  for (const fp of dataObj.featured_prices || []) {
    add(nightRateValue(fp.rate_per_night));
    add(nightRateValue(fp.rooms?.[0]?.rate_per_night));
  }
  return rates;
}

function isCitizenMHotel(hotelName = "", matchName = "", dataName = "") {
  const blob = `${hotelName || ""} ${matchName || ""} ${dataName || ""}`.toLowerCase();
  return /\bcitizen\s*m\b/.test(blob) || blob.includes("citizenm");
}

function findMarriottBookLink(dataObj) {
  for (const p of dataObj?.prices || []) {
    const link = decodeGoogleLink(p.link || p.url, p.source || "");
    if (link && linkIncludesHost(link, "marriott.com")) return link;
    const src = (p.source || "").toLowerCase();
    if (src.includes("marriott") && link) return link;
  }
  const hotelLink = dataObj?.link || "";
  if (hotelLink && linkIncludesHost(hotelLink, "marriott.com")) return hotelLink;
  return null;
}

const CITIZEN_M_MARRIOTT_MAP = [
  { match: "victoria station", propCode: "LONVS" },
  { match: "tower of london", propCode: "LONTL" },
  { match: "shoreditch", propCode: "LONST" },
  { match: "bankside", propCode: "LONBK" },
  { match: "covent garden", propCode: "LONCG" },
];

function fmtBookingDate(ds) {
  const [y, m, d] = ds.split("-");
  return `${m}/${d}/${y}`;
}

function resolveCitizenMMarriottPropCode(hotelName = "", matchName = "", dataObj = null) {
  const marriottLink = findMarriottBookLink(dataObj);
  if (marriottLink) {
    const pc = marriottLink.match(/[?&]propertyCode=([A-Z0-9]{4,8})/i);
    if (pc) return pc[1].toUpperCase();
    const tr = marriottLink.match(/hotels\/travel\/([a-z0-9]{4,8})-/i);
    if (tr) return tr[1].toUpperCase();
  }
  const blob = `${hotelName || ""} ${matchName || ""} ${dataObj?.name || ""}`.toLowerCase();
  for (const entry of CITIZEN_M_MARRIOTT_MAP) {
    if (blob.includes(entry.match)) return entry.propCode;
  }
  return null;
}

function buildCitizenMMarriottBookingUrl(hotelName, matchName, dataObj, checkIn, checkOut) {
  const propCode = resolveCitizenMMarriottPropCode(hotelName, matchName, dataObj);
  if (propCode) {
    return (
      `https://www.marriott.com/reservation/availabilitySearch.mi?propertyCode=${propCode}` +
      `&fromDate=${encodeURIComponent(fmtBookingDate(checkIn))}` +
      `&toDate=${encodeURIComponent(fmtBookingDate(checkOut))}` +
      `&numberOfRooms=1&numAdultsPerGuestRoom=2`
    );
  }
  return findMarriottBookLink(dataObj);
}

function pickCitizenMMarriottRate(dataObj, hotelName = "", matchName = "") {
  if (!isCitizenMHotel(hotelName, matchName, dataObj?.name)) return null;
  const prices = dataObj?.prices || [];

  const rowFromPrice = (p) => {
    const rate = brandDisplayRate(p.rate_per_night) || publicDisplayRate(p.rate_per_night);
    if (!rate) return null;
    const link = decodeGoogleLink(p.link || p.url, p.source || "");
    const src = (p.source || "").toLowerCase();
    if (src.includes("booking") || (link && linkIncludesHost(link, "booking.com"))) return null;
    return {
      rate,
      source: "Marriott",
      official: !!p.official,
      link,
    };
  };

  for (const p of prices) {
    if (!(p.source || "").toLowerCase().includes("marriott")) continue;
    const pick = rowFromPrice(p);
    if (pick) return pick;
  }

  for (const p of prices) {
    const link = decodeGoogleLink(p.link || p.url, p.source || "");
    if (!link || !linkIncludesHost(link, "marriott.com")) continue;
    const pick = rowFromPrice(p);
    if (pick) return pick;
  }

  return null;
}

/** Prefer a prices[] row whose decoded link is on the hotel's own domain. */
function pickBrandHostnameDirectRate(dataObj) {
  const prices = dataObj.prices || [];
  for (const host of BRAND_HOST_PRIORITY) {
    for (const p of prices) {
      const link = decodeGoogleLink(p.link || p.url);
      if (!link || !linkIncludesHost(link, host)) continue;
      const rate = brandDisplayRate(p.rate_per_night);
      if (rate) {
        return {
          rate,
          source: priceRowSourceLabel(p, dataObj, host),
          official: !!p.official,
        };
      }
    }
  }
  return null;
}

/** Brand / official row from prices[] (display rate, not raw before_taxes only). */
function pickOfficialBrandRate(dataObj, hotelName = "", matchName = "") {
  const citizenPick = pickCitizenMMarriottRate(dataObj, hotelName, matchName);
  if (citizenPick) return citizenPick;

  if (isCitizenMHotel(hotelName, matchName, dataObj?.name)) return null;

  const hostnamePick = pickBrandHostnameDirectRate(dataObj);
  if (hostnamePick) return hostnamePick;

  const prices = dataObj.prices || [];
  const official = prices.find(p => p.official === true);
  if (official) {
    const rate = brandDisplayRate(official.rate_per_night);
    if (rate) {
      return {
        rate,
        source: priceRowSourceLabel(official, dataObj),
        official: true,
      };
    }
  }
  for (const [, frags] of Object.entries(BRAND_SOURCES)) {
    const brand = prices.find(
      p => p.source && frags.some(f => p.source.toLowerCase().includes(f))
    );
    if (brand) {
      const rate = brandDisplayRate(brand.rate_per_night);
      if (rate) {
        return {
          rate,
          source: priceRowSourceLabel(brand, dataObj),
          official: false,
        };
      }
    }
  }
  return null;
}

function pickBrandDirectRate(dataObj) {
  const pick = pickOfficialBrandRate(dataObj);
  return pick ? pick.rate : null;
}

function normalizeHotelNameForMatch(name) {
  return (name || "")
    .toLowerCase()
    .replace(/['.]/g, "")
    .replace(/\b(by proper|autograph collection|a luxury collection hotel|curio collection|tapestry collection)\b/gi, " ")
    .replace(/\b(the|hotel|resort|suites?|collection|marriott|hilton|hyatt)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

function hotelNameMatchScore(requested, candidate) {
  const a = normalizeHotelNameForMatch(requested);
  const b = normalizeHotelNameForMatch(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.88;
  const ta = a.split(" ").filter(t => t.length > 2);
  const tb = b.split(" ").filter(t => t.length > 2);
  if (!ta.length || !tb.length) return 0;
  const setB = new Set(tb);
  const setA = new Set(ta);
  const inter = ta.filter(t => setB.has(t));
  const union = new Set([...ta, ...tb]);
  let score = inter.length / union.size;
  const onlyA = ta.filter(t => !setB.has(t));
  const onlyB = tb.filter(t => !setA.has(t));
  for (const x of onlyA) {
    for (const y of onlyB) {
      if (x.length > 4 && y.length > 4 && levenshtein(x, y) === 1) score *= 0.42;
    }
  }
  return score;
}

function findBestPropertyMatch(properties, requestedName, city = "") {
  const acProp = AguaCaliente.resolveAguaCalienteProperty(requestedName, city);
  if (acProp) {
    for (const p of properties) {
      if (AguaCaliente.matchesAguaCalienteProperty(p.name, acProp)) {
        return { match: p, score: 1 };
      }
    }
    return { match: null, score: 0 };
  }

  let best = null;
  let bestScore = 0;
  for (const p of properties) {
    const score = hotelNameMatchScore(requestedName, p.name || "");
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  if (!best || bestScore < HOTEL_MATCH_MIN_SCORE) return { match: null, score: bestScore };
  return { match: best, score: bestScore };
}

function extractAguaCalienteOffer(dataObj, checkIn, checkOut, prop, currency = "USD") {
  if (!prop) return null;
  for (const p of dataObj?.prices || []) {
    const source = (p.source || "").toLowerCase();
    const link = decodeGoogleLink(p.link || p.url, p.source || "");
    if (!source.includes("agua caliente") && !AguaCaliente.isAguaCalienteBrandUrl(link)) continue;
    const rate =
      brandDisplayRate(p.rate_per_night) || publicDisplayRate(p.rate_per_night);
    return {
      rate,
      url: AguaCaliente.buildAguaCalienteBookingUrl(prop, checkIn, checkOut, link, currency),
    };
  }
  return {
    rate: null,
    url: AguaCaliente.buildAguaCalienteBookingUrl(prop, checkIn, checkOut, null, currency),
  };
}

function extractValidatedRate(dataObj, nights, hotelName = "", matchName = "") {
  const headline = publicDisplayRate(dataObj.rate_per_night);
  const brandPick = pickOfficialBrandRate(dataObj, hotelName, matchName);
  const candidates = collectRateCandidates(dataObj);

  if (isCitizenMHotel(hotelName, matchName, dataObj?.name) && !brandPick?.rate) {
    return { ok: false, reason: "no_brand_rate", rate: null, total: null };
  }

  if (!candidates.length && !headline) {
    return { ok: false, reason: "no_rates", rate: null, total: null };
  }

  // Official brand rate is trusted unless it is far above headline (e.g. premium member noise).
  if (brandPick?.rate && headline && brandPick.official) {
    if (brandPick.rate <= headline * (1 + BRAND_OFFICIAL_MAX_ABOVE_HEADLINE)) {
      return {
        ok: true,
        rate: brandPick.rate,
        total: brandPick.rate * nights,
        confidence: "high",
        method: "brand_official",
        rate_source_label: sanitizeRateSourceLabel(brandPick.source),
        headline,
        agreeing: 1,
        spread: 1,
      };
    }
  } else if (brandPick?.rate && headline) {
    const diff = Math.abs(brandPick.rate - headline) / headline;
    if (diff <= BRAND_HEADLINE_MAX_DIFF) {
      return {
        ok: true,
        rate: brandPick.rate,
        total: brandPick.rate * nights,
        confidence: "medium",
        method: "brand_direct",
        rate_source_label: sanitizeRateSourceLabel(brandPick.source),
        headline,
        agreeing: 1,
        spread: 1,
      };
    }
  }

  if (headline) {
    return {
      ok: true,
      rate: headline,
      total: headline * nights,
      confidence: "medium",
      method: "headline",
      rate_source_label: null,
      headline,
      agreeing: 1,
      spread: 1,
    };
  }

  const brandRate = brandPick?.rate ?? null;
  const sorted = [...new Set(candidates.map(r => Math.round(r)))].sort((a, b) => a - b);
  const spread = sorted.length > 1 ? sorted[sorted.length - 1] / sorted[0] : 1;
  const anchor = headline || sorted[Math.floor(sorted.length * 0.75)];
  const agreeing = sorted.filter(r => r >= anchor * RATE_AGREE_MIN && r <= anchor * RATE_AGREE_MAX);

  if (spread > RATE_MAX_SPREAD && agreeing.length < 2) {
    return {
      ok: false,
      reason: "rate_disagreement",
      rate: null,
      total: null,
      headline,
      candidates: sorted,
      spread: Math.round(spread * 100) / 100,
    };
  }

  let rate;
  let method;
  let rateSourceLabel = null;
  if (
    brandRate &&
    brandRate >= anchor * RATE_AGREE_MIN &&
    brandRate <= anchor * RATE_AGREE_MAX
  ) {
    rate = Math.round(brandRate);
    method = "brand_direct";
    rateSourceLabel = sanitizeRateSourceLabel(brandPick?.source);
  } else if (headline && (agreeing.length >= 1 || sorted.length === 1)) {
    rate = Math.round(headline);
    method = "headline";
  } else if (agreeing.length >= 2) {
    rate = median(agreeing);
    method = "consensus";
  } else {
    const p75 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))];
    rate = Math.round(p75);
    method = "p75";
    if (headline && rate < headline * RATE_AGREE_MIN) {
      return {
        ok: false,
        reason: "rate_disagreement",
        rate: null,
        total: null,
        headline,
        candidates: sorted,
        spread,
      };
    }
  }

  const confidence =
    agreeing.length >= 3 ? "high" :
    agreeing.length >= 2 || method === "headline" || method === "brand_direct" ? "medium" :
    "low";

  return {
    ok: true,
    rate,
    total: rate * nights,
    confidence,
    method,
    rate_source_label: sanitizeRateSourceLabel(rateSourceLabel),
    headline,
    agreeing: agreeing.length,
    spread: Math.round(spread * 100) / 100,
  };
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
      let raw = url;
      for (let i = 0; i < 5; i++) {
        try {
          const next = decodeURIComponent(raw);
          if (next === raw) break;
          raw = next;
        } catch {
          break;
        }
      }
      const proper = raw.match(/(https?:\/\/(?:www\.)?properhotel\.com[^\s"<>]+)/i);
      if (proper) return proper[1].split(/[?&]dclid=/)[0];
      const m = raw.match(/(https?:\/\/(?:www\.)?(?:marriott|ritzcarlton|hilton|waldorfastoria|hyatt|ihg|intercontinental|kimptonhotels|holidayinn|crowneplaza|staybridge|candlewood|aguacalientecasinos|secure-hotel-tracker|booking|expedia|hotels|agoda)\.[^\s"'<>\n]+)/i);
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
function extractBookingUrl(dataObj, checkIn, checkOut, aguaProp, currency = "USD", hotelName = "", matchName = "") {
  const prices = dataObj.prices || [];
  if (!prices.length) {
    return aguaProp
      ? AguaCaliente.buildAguaCalienteBookingUrl(aguaProp, checkIn, checkOut, null, currency)
      : null;
  }

  if (isCitizenMHotel(hotelName, matchName, dataObj?.name)) {
    return buildCitizenMMarriottBookingUrl(hotelName, matchName, dataObj, checkIn, checkOut);
  }

  // Decode all links upfront, drop ones that can't be resolved
  const decoded = prices
    .map(p => ({
      source: (p.source || "").toLowerCase(),
      link: decodeGoogleLink(p.link || p.url, p.source || ""),
    }))
    .filter(p => p.link);

  // 0. Agua Caliente brand row (never Booking.com when brand link exists)
  for (const row of decoded) {
    if (row.source.includes("agua caliente") || AguaCaliente.isAguaCalienteBrandUrl(row.link)) {
      return AguaCaliente.buildAguaCalienteBookingUrl(
        aguaProp,
        checkIn,
        checkOut,
        row.link,
        currency
      );
    }
  }

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

function isPortfolioChainHotel(hotelName, matchName) {
  if (AguaCaliente.resolveAguaCalienteProperty(hotelName, "")) return false;
  if (AguaCaliente.resolveAguaCalienteProperty(matchName, "")) return false;
  if (isProperHotelName(hotelName) || isProperHotelName(matchName)) return true;
  if (isCitizenMHotel(hotelName, matchName)) return true;
  const blob = `${hotelName || ""} ${matchName || ""}`.toLowerCase();
  for (const frags of Object.values(BRAND_SOURCES)) {
    if (frags.some(f => blob.includes(f))) return true;
  }
  return false;
}

function hasBrandBookableRate(dataObj, hotelName = "", matchName = "") {
  if (
    isProperHotelName(hotelName) ||
    isProperHotelName(matchName) ||
    isProperHotelName(dataObj?.name || "")
  ) {
    const official = (dataObj?.prices || []).find(p => p.official);
    if (official) {
      const rate =
        brandDisplayRate(official.rate_per_night) || publicDisplayRate(official.rate_per_night);
      if (rate) return true;
    }
    if (publicDisplayRate(dataObj?.rate_per_night)) return true;
  }

  if (isCitizenMHotel(hotelName, matchName, dataObj?.name)) {
    return !!pickCitizenMMarriottRate(dataObj, hotelName, matchName);
  }

  const prices = dataObj?.prices || [];
  for (const host of BRAND_HOST_PRIORITY) {
    for (const p of prices) {
      const link = decodeGoogleLink(p.link || p.url, p.source || "");
      if (!link || !linkIncludesHost(link, host)) continue;
      const rate = brandDisplayRate(p.rate_per_night) || publicDisplayRate(p.rate_per_night);
      if (rate) return true;
    }
  }
  return false;
}

function resolveSandboxBookingUrl(rateSource, checkin, checkout, acProp, currency, hotel, matchName, city) {
  let bookingUrl = extractBookingUrl(rateSource, checkin, checkout, acProp, currency, hotel, matchName);
  const ihgInfo = extractIhgInfo(rateSource);
  if (ihgInfo) bookingUrl = buildIhgBookingUrl(ihgInfo, checkin, checkout);
  if (isProperHotelName(hotel) || isProperHotelName(matchName)) {
    const built = buildProperBookingUrlServer(matchName, city, checkin, checkout);
    if (built) bookingUrl = built;
  }
  if (isCitizenMHotel(hotel, matchName, rateSource?.name)) {
    const built = buildCitizenMMarriottBookingUrl(hotel, matchName, rateSource, checkin, checkout);
    if (built && built.includes("marriott.com")) bookingUrl = built;
  }
  return { bookingUrl, ihgInfo };
}

function chainNoBrandRateResult(
  hotel,
  checkin,
  checkout,
  nights,
  currency,
  matchName,
  matchScore,
  bookingUrl,
  ihgInfo
) {
  const marriottBook = bookingUrl && /marriott\.com/i.test(bookingUrl);
  const citizenM = isCitizenMHotel(hotel, matchName);
  return {
    rate: null,
    source: "live",
    property_name: matchName,
    check_in: checkin,
    check_out: checkout,
    total: null,
    nights,
    currency,
    error: marriottBook && citizenM ? null : "rate_unverified",
    message: marriottBook && citizenM
      ? CITIZEN_M_NO_RATE_MESSAGE
      : RATE_UNVERIFIED_MESSAGE,
    rate_warning: "no_brand_rate",
    booking_url: marriottBook ? bookingUrl : null,
    booking_host: marriottBook ? "marriott.com" : null,
    rate_source_label: marriottBook ? "Marriott" : null,
    citizen_m_marriott: !!(marriottBook && citizenM),
    rate_disclaimer: RATE_DISCLAIMER,
    rate_basis: "nightly_before_taxes_fees",
    matched_property: matchName,
    match_score: matchScore,
    ...(ihgInfo && {
      ihg_brand: ihgInfo.brand,
      ihg_region: ihgInfo.region,
      ihg_locale: ihgInfo.locale,
      ihg_prop_code: ihgInfo.propCode,
    }),
  };
}

const ProperAzds = require(path.join(__dirname, "proper-azds.js"));
const AguaCaliente = require(path.join(__dirname, "..", "agua-caliente.js"));

// Open Proper Hotels on properhotel.com (AZDS booking). Sister portfolio properties
// (Hotel June, Avalon, Ingleside, Montauk Yacht Club, Culver Hotel, etc.) book on
// their own domains — SerpAPI OTA/brand links are used for those.
const PROPER_HOTEL_MAP = [
  { match: "shelborne", slug: "proper-shelborne", path: "shelborne" },
  { match: "santa monica", slug: "proper-santa-monica", path: "santa-monica" },
  { match: "san francisco", slug: "proper-sf", path: "san-francisco" },
  { match: "downtown la", slug: "proper-downtown-la", path: "downtown-la" },
  { match: "downtown l.a", slug: "proper-downtown-la", path: "downtown-la" },
  { match: "dtla", slug: "proper-downtown-la", path: "downtown-la" },
  { match: "los angeles", slug: "proper-downtown-la", path: "downtown-la" },
  { match: "austin", slug: "proper-austin", path: "austin" },
  // Coming soon on properhotel.com (booking not live yet): dallas, lake-tahoe, palm-springs
];

function isProperHotelName(name) {
  const n = (name || "").toLowerCase();
  return n.includes("proper") || n.includes("shelborne");
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
  const address = p.address || "";
  const fromAddress = Currency.cityFromAddress(address);
  const fromName = Currency.inferCityFromQuery(p.name);
  let city = fromAddress || cityHint;
  if (!fromAddress && fromName) city = fromName;
  if (city && !fromAddress && Currency.resolveLocalCurrency(city, address, p.name) === "USD" && fromName) {
    city = fromName;
  }
  return {
    id: `sb-${city.replace(/\s+/g, "-").toLowerCase()}-${idx}`,
    name: p.name,
    city,
    region: "",
    stars,
    baseRate,
    url: p.link || "",
    address,
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

function liveUnavailableResult(hotel, checkin, checkout, nights, currency, error, message, extra = {}) {
  return {
    rate: null,
    source: "live",
    property_name: hotel,
    check_in: checkin,
    check_out: checkout,
    total: null,
    nights,
    currency,
    error,
    message,
    ...extra,
  };
}

function normalizeDisplayMode(raw) {
  return raw === "local" ? "local" : "USD";
}

function finalizeRatePayload(payload, displayMode, city, address, hotel) {
  const mode = normalizeDisplayMode(displayMode);
  const local = Currency.resolveLocalCurrency(city, address, hotel);
  const withOriginal = {
    ...payload,
    original_rate: payload.original_rate ?? payload.rate ?? null,
    original_currency: payload.original_currency ?? payload.currency ?? local,
    local_currency: payload.local_currency ?? local,
  };
  return Currency.attachDisplayRates(withOriginal, mode, city, address, hotel);
}

function stampOriginalFields(payload, serpCur, localCurrency) {
  const fetchCurrency = serpCur || localCurrency || payload.currency || "USD";
  return {
    ...payload,
    original_rate: payload.original_rate ?? payload.rate ?? null,
    original_currency: fetchCurrency,
    currency: fetchCurrency,
    local_currency: localCurrency,
  };
}

function respondRate(res, payload, displayMode, city, cacheKey, serpCur, localCurrency, address, hotel) {
  const stamped = stampOriginalFields(payload, serpCur, localCurrency);
  cacheSet(rateCache, cacheKey, stamped);
  return res.json(finalizeRatePayload(stamped, displayMode, city, address, hotel));
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

  if (AguaCaliente.isAguaCalienteQuery(q, city)) {
    const curated = AguaCaliente.curatedHotelsForSearch(excludeSet);
    console.log(`[Agua Caliente] Curated search → ${curated.length} properties`);
    return res.json(curated);
  }

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
    const cityHint = city || Currency.inferCityFromQuery(q) || (q.split(" ").length > 2 ? q.split(" ").pop() : q);

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
app.get("/api/currency/local", (req, res) => {
  const city = (req.query.city || "").trim();
  res.json({
    city,
    local_currency: Currency.resolveLocalCurrency(city, null, null),
  });
});

app.get("/api/rates", async (req, res) => {
  const { hotel, city, checkin, checkout } = req.query;
  const address = (req.query.address || "").trim();
  const propertyToken = req.query.propertyToken || null;
  const displayMode = normalizeDisplayMode(req.query.displayCurrency);

  if (!hotel || !city || !checkin || !checkout) {
    return res.status(400).json({ error: "Missing required params: hotel, city, checkin, checkout" });
  }

  const nights = Math.max(1, Math.round((new Date(checkout) - new Date(checkin)) / 86400000));
  const localCurrency = Currency.resolveLocalCurrency(city, address, hotel);
  // Fetch SerpAPI in destination currency so original_rate matches the booking offer row.
  const serpCurrency = localCurrency;
  const { currency: serpCur, gl } = Currency.googleHotelsLocale(serpCurrency);
  let currency = serpCur;
  const cacheKey = propertyToken
    ? `pt:${propertyToken}|${checkin}|${checkout}|${serpCur}`
    : `${hotel}|${city}|${checkin}|${checkout}|${serpCur}`;
  const bust = req.query.bust === '1';

  if (!bust) {
    const cached = cacheGet(rateCache, cacheKey, RATE_TTL_MS);
    if (cached) {
      console.log(`[Rate Cache] HIT ${hotel}`);
      return res.json(finalizeRatePayload(cached, displayMode, city, address, hotel));
    }
  }

  if (!SERPAPI_KEY) {
    return res.status(500).json({ error: "SERPAPI_KEY not configured" });
  }

  if (!canUseLiveCall()) {
    const result = demoFallbackResult(hotel, checkin, checkout, nights, currency, "daily_limit");
    return respondRate(res, result, displayMode, city, cacheKey, serpCur, localCurrency, address, hotel);
  }

  try {
    const buildHotelsUrl = (cur, gl) => {
      const base = `https://serpapi.com/search.json?engine=google_hotels&q=${encodeURIComponent(`${hotel} ${city}`)}&check_in_date=${checkin}&check_out_date=${checkout}&currency=${cur}&gl=${gl}&hl=en&api_key=${SERPAPI_KEY}`;
      return propertyToken
        ? `${base}&property_token=${encodeURIComponent(propertyToken)}`
        : base;
    };

    let nameUrl = buildHotelsUrl(serpCur, gl);
    let tokenUrl = propertyToken ? nameUrl : null;

    recordLiveCall(`rate "${hotel}"`);
    console.log(`[SerpAPI Rate] "${hotel}", ${city} | ${checkin} → ${checkout} | ${serpCur}${tokenUrl ? " (token)" : ""}`);

    const fetchHotelData = async (cur, glParam) => {
      const res = await fetch(buildHotelsUrl(cur, glParam));
      return res.json();
    };

    let data = await fetchHotelData(serpCur, gl);

    // If token call returned no rate data, fall back to name+city search (strict match only)
    if (tokenUrl && !data.error && data.type !== "hotel" && !(data.properties || []).length) {
      if (!canUseLiveCall()) {
        const result = demoFallbackResult(hotel, checkin, checkout, nights, currency, "daily_limit");
        return respondRate(res, result, displayMode, city, cacheKey, serpCur, localCurrency, address, hotel);
      }
      console.log(`[SerpAPI Rate] Token returned empty — falling back to name+city search`);
      recordLiveCall(`rate fallback "${hotel}"`);
      data = await fetchHotelData(serpCur, gl);
    }

    if (data.error) {
      console.error("[SerpAPI Rate Error]", data.error);
      const result = liveUnavailableResult(
        hotel, checkin, checkout, nights, currency, "api_error", String(data.error)
      );
      return respondRate(res, result, displayMode, city, cacheKey, serpCur, localCurrency, address, hotel);
    }

    let matchName = hotel;
    let matchScore = propertyToken ? 1 : null;
    let rateSource = data;
    let bookingUrl = null;
    let ihgInfo = null;

    if (data.type === "hotel") {
      matchName = data.name || hotel;
      matchScore = propertyToken ? 1 : hotelNameMatchScore(hotel, matchName);
      rateSource = data;
    } else {
      const properties = data.properties || [];
      if (properties.length === 0) {
        const result = liveUnavailableResult(
          hotel, checkin, checkout, nights, currency, "no_results",
          "No hotels returned for this search."
        );
        return respondRate(res, result, displayMode, city, cacheKey, serpCur, localCurrency, address, hotel);
      }

      let { match, score } = findBestPropertyMatch(properties, hotel, city);
      const acPropEarly = AguaCaliente.resolveAguaCalienteProperty(hotel, city);
      if (!match && acPropEarly && canUseLiveCall()) {
        console.log(`[Agua Caliente] Refetching "${acPropEarly.displayName}"`);
        recordLiveCall(`rate agua "${acPropEarly.displayName}"`);
        const refetch = await fetch(
          `https://serpapi.com/search.json?engine=google_hotels&q=${encodeURIComponent(acPropEarly.displayName)}` +
          `&check_in_date=${checkin}&check_out_date=${checkout}&currency=${serpCur}&gl=${gl}&hl=en&api_key=${SERPAPI_KEY}`
        ).then(r => r.json());
        if (!refetch.error && refetch.type === "hotel") {
          rateSource = refetch;
          matchName = refetch.name || acPropEarly.displayName;
          matchScore = 1;
          match = refetch;
        }
      }
      if (!match) {
        if (acPropEarly) {
          console.log(`[Agua Caliente] No Google Hotels listing — brand book URL only (${acPropEarly.city})`);
          const brandUrl = AguaCaliente.buildAguaCalienteBookingUrl(
            acPropEarly,
            checkin,
            checkout,
            null,
            currency
          );
          const result = {
            rate: null,
            source: "live",
            property_name: acPropEarly.displayName,
            check_in: checkin,
            check_out: checkout,
            total: null,
            nights,
            currency,
            booking_url: brandUrl,
            rate_disclaimer: RATE_DISCLAIMER,
            rate_basis: "nightly_before_taxes_fees",
            rate_source_label: "Agua Caliente",
            rate_confidence: "low",
            rate_method: "brand_direct",
            agua_caliente: true,
            rooms_on_google_hotels: false,
            message:
              "No room rates in Google Hotels for this property. Book links to the official Agua Caliente site.",
          };
          return respondRate(res, result, displayMode, city, cacheKey, serpCur, localCurrency, address, hotel);
        }
        console.log(`[SerpAPI Rate] No confident hotel match (best score ${score.toFixed(2)})`);
        const result = liveUnavailableResult(
          hotel, checkin, checkout, nights, currency, "hotel_mismatch",
          "Could not match this hotel in Google Hotels results.",
          { match_score: score }
        );
        return respondRate(res, result, displayMode, city, cacheKey, serpCur, localCurrency, address, hotel);
      }

      rateSource = match;
      matchName = match.name || hotel;
      matchScore = score;
    }

    if (!propertyToken && matchScore != null && matchScore < HOTEL_MATCH_MIN_SCORE) {
      const result = liveUnavailableResult(
        hotel, checkin, checkout, nights, currency, "hotel_mismatch",
        `Matched "${matchName}" but name similarity is too low.`,
        { matched_property: matchName, match_score: matchScore }
      );
      return respondRate(res, result, displayMode, city, cacheKey, serpCur, localCurrency, address, hotel);
    }

    currency = serpCur;

    const acProp =
      AguaCaliente.resolveAguaCalienteProperty(hotel, city) ||
      AguaCaliente.resolveAguaCalienteProperty(matchName, city);

    const detailToken = propertyToken || rateSource.property_token;
    if (acProp && detailToken && !(rateSource.prices?.length) && canUseLiveCall()) {
      recordLiveCall(`rate agua detail "${hotel}"`);
      const detailData = await fetch(
        `https://serpapi.com/search.json?engine=google_hotels&q=${encodeURIComponent(acProp.displayName)}` +
        `&check_in_date=${checkin}&check_out_date=${checkout}&currency=${serpCur}&gl=${gl}&hl=en` +
        `&property_token=${encodeURIComponent(detailToken)}&api_key=${SERPAPI_KEY}`
      ).then(r => r.json());
      if (!detailData.error && detailData.type === "hotel") {
        rateSource = detailData;
        matchName = detailData.name || matchName;
      }
    }

    if (
      isPortfolioChainHotel(hotel, matchName) &&
      !acProp &&
      !hasBrandBookableRate(rateSource, hotel, matchName)
    ) {
      const { bookingUrl: brandBookUrl, ihgInfo: brandIhg } = resolveSandboxBookingUrl(
        rateSource,
        checkin,
        checkout,
        acProp,
        currency,
        hotel,
        matchName,
        city
      );
      console.log(
        `[SerpAPI Rate] No brand-site rate for "${matchName}" — suppressing OTA matrix price` +
        (brandBookUrl ? ` (Book → ${brandBookUrl.slice(0, 72)}…)` : "")
      );
      const result = chainNoBrandRateResult(
        hotel,
        checkin,
        checkout,
        nights,
        currency,
        matchName,
        matchScore,
        brandBookUrl,
        brandIhg
      );
      return respondRate(res, result, displayMode, city, cacheKey, serpCur, localCurrency, address, hotel);
    }

    const validated = extractValidatedRate(rateSource, nights, hotel, matchName);
    if (!validated.ok) {
      console.log(
        `[SerpAPI Rate] REJECTED ${validated.reason} for "${matchName}"` +
        (validated.candidates ? ` candidates=[${validated.candidates.join(", ")}]` : "")
      );
      const extra = {
        rate_warning: validated.reason,
        matched_property: matchName,
        match_score: matchScore,
        rate_candidates: validated.candidates || null,
      };
      const result = liveUnavailableResult(
        hotel, checkin, checkout, nights, currency, "rate_unverified",
        RATE_UNVERIFIED_MESSAGE,
        extra
      );
      return respondRate(res, result, displayMode, city, cacheKey, serpCur, localCurrency, address, hotel);
    }

    let { rate, total } = validated;
    const resolved = resolveSandboxBookingUrl(
      rateSource,
      checkin,
      checkout,
      acProp,
      currency,
      hotel,
      matchName,
      city
    );
    bookingUrl = resolved.bookingUrl;
    ihgInfo = resolved.ihgInfo;

    if (acProp) {
      const acOffer = extractAguaCalienteOffer(rateSource, checkin, checkout, acProp, currency);
      if (acOffer?.url) bookingUrl = acOffer.url;
      if (acOffer?.rate) {
        rate = acOffer.rate;
        total = rate * nights;
      }
      console.log(`[Agua Caliente] Book → ${bookingUrl?.slice(0, 90)}…`);
    }

    console.log(
      `[SerpAPI Rate] "${matchName}" $${rate}/night (${validated.confidence}, ${validated.method})` +
      (matchScore != null && matchScore < 1 ? ` match=${matchScore.toFixed(2)}` : "")
    );

    if (ihgInfo) console.log(`[SerpAPI Rate] IHG info: brand=${ihgInfo.brand} propCode=${ihgInfo.propCode}`);
    if (isProperHotelName(hotel) || isProperHotelName(matchName)) {
      const built = buildProperBookingUrlServer(matchName, city, checkin, checkout);
      if (built) {
        bookingUrl = built;
        console.log(`[Proper] booking URL → ${bookingUrl.includes("step-2") ? "step-2 (dates)" : "step-1 (pick dates)"}`);
      }
    }

    const rateSourceLabel = rateSourceLabelForBookingUrl(
      bookingUrl,
      validated.rate_source_label,
      matchName,
      hotel
    );

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
      rate_disclaimer: RATE_DISCLAIMER,
      rate_basis: "nightly_before_taxes_fees",
      rate_source_label: rateSourceLabel || null,
      rate_confidence: validated.confidence,
      rate_method: validated.method,
      match_score: matchScore,
      ...(ihgInfo && {
        ihg_brand: ihgInfo.brand,
        ihg_region: ihgInfo.region,
        ihg_locale: ihgInfo.locale,
        ihg_prop_code: ihgInfo.propCode,
      }),
    };

    return respondRate(res, result, displayMode, city, cacheKey, serpCur, localCurrency, address, hotel);
  } catch (err) {
    console.error("[Rate Error]", err.message);
    return respondRate(res, liveUnavailableResult(
      hotel, checkin, checkout, nights, currency, "api_error", err.message
    ), displayMode, city, cacheKey, serpCur, localCurrency, address, hotel);
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
