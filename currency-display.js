/**
 * Display currency helpers for hotel rate comparison.
 * SerpAPI rates are fetched in the destination's local currency; display conversion
 * is for comparison only — original_rate/original_currency stay aligned with the offer row.
 */

const CITY_CURRENCY = {
  london: "GBP", dublin: "EUR", paris: "EUR", barcelona: "EUR", rome: "EUR",
  vienna: "EUR", prague: "EUR", lisbon: "EUR", amsterdam: "EUR",
  budapest: "EUR", tokyo: "JPY", kyoto: "JPY", osaka: "JPY", "hong kong": "HKD",
  bangkok: "THB", singapore: "SGD", sydney: "AUD", miami: "USD", "new york": "USD",
  "los angeles": "USD", chicago: "USD", boston: "USD", seattle: "USD",
  austin: "USD", "san francisco": "USD", "miami beach": "USD", "palm springs": "USD",
  chicago: "USD", dallas: "USD", denver: "USD", honolulu: "USD", vancouver: "CAD",
  toronto: "CAD", montreal: "CAD", mexico: "MXN", "mexico city": "MXN",
};

const COUNTRY_CURRENCY = {
  ireland: "EUR", uk: "GBP", "united kingdom": "GBP", england: "GBP",
  scotland: "GBP", wales: "GBP", france: "EUR", germany: "EUR", italy: "EUR",
  spain: "EUR", portugal: "EUR", netherlands: "EUR", austria: "EUR", japan: "JPY",
  australia: "AUD", mexico: "MXN", canada: "CAD", thailand: "THB", singapore: "SGD",
};

const CURRENCY_GL = {
  EUR: "ie", GBP: "uk", USD: "us", JPY: "jp", AUD: "au", CAD: "ca", MXN: "mx",
  HKD: "hk", THB: "th", SGD: "sg",
};

/** Static USD conversion rates for display comparison (not live trading rates). */
const USD_PER_UNIT = {
  USD: 1,
  EUR: 1.08,
  GBP: 1.27,
  JPY: 0.0067,
  AUD: 0.65,
  CAD: 0.73,
  MXN: 0.058,
  HKD: 0.13,
  THB: 0.028,
  SGD: 0.74,
};

const DISPLAY_CURRENCY_NOTE =
  "Rates are shown for comparison and may not include taxes, resort fees, or other charges.";

function cityFromAddress(address) {
  if (!address) return null;
  const parts = address.split(",").map((s) => s.trim()).filter(Boolean);
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

function resolveLocalCurrency(cityName, address, hotelName) {
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

function serpFetchCurrency(displayMode, cityName) {
  if (displayMode === "local") {
    return resolveLocalCurrency(cityName, null, null);
  }
  return "USD";
}

function canConvertCurrency(fromCurrency, toCurrency) {
  if (!fromCurrency || !toCurrency) return false;
  if (fromCurrency === toCurrency) return true;
  return USD_PER_UNIT[fromCurrency] != null && USD_PER_UNIT[toCurrency] != null;
}

function convertRate(amount, fromCurrency, toCurrency) {
  if (amount == null || amount <= 0) return null;
  if (fromCurrency === toCurrency) return Math.round(amount);
  if (!canConvertCurrency(fromCurrency, toCurrency)) return null;
  const usd = amount * USD_PER_UNIT[fromCurrency];
  const converted = usd / USD_PER_UNIT[toCurrency];
  if (toCurrency === "JPY") return Math.round(converted);
  return Math.round(converted);
}

function buildDisplayRateFields(originalRate, originalCurrency, displayMode, localCurrency) {
  const local = localCurrency || originalCurrency || "USD";
  const targetCurrency = displayMode === "local" ? local : "USD";
  const base = {
    original_rate: originalRate ?? null,
    original_currency: originalCurrency || local,
    local_currency: local,
    display_currency_mode: displayMode === "local" ? "local" : "USD",
    conversion_available: true,
  };

  if (originalRate == null) {
    return {
      ...base,
      rate: null,
      currency: targetCurrency,
      total: null,
      conversion_available: false,
    };
  }

  if (originalCurrency === targetCurrency) {
    return {
      ...base,
      rate: originalRate,
      currency: targetCurrency,
      total: null,
      conversion_available: true,
    };
  }

  const converted = convertRate(originalRate, originalCurrency, targetCurrency);
  if (converted == null) {
    return {
      ...base,
      rate: originalRate,
      currency: originalCurrency,
      total: null,
      conversion_available: false,
    };
  }

  return {
    ...base,
    rate: converted,
    currency: targetCurrency,
    total: null,
    conversion_available: true,
  };
}

function attachDisplayRates(payload, displayMode, cityName) {
  const localCurrency = resolveLocalCurrency(cityName, null, null);
  const originalRate = payload.original_rate ?? payload.rate ?? null;
  const originalCurrency =
    payload.original_currency || payload.currency || localCurrency;
  const display = buildDisplayRateFields(
    originalRate,
    originalCurrency,
    displayMode,
    localCurrency
  );
  const nights = payload.nights || 1;
  return {
    ...payload,
    ...display,
    total: display.rate != null ? display.rate * nights : payload.total ?? null,
  };
}

module.exports = {
  CITY_CURRENCY,
  COUNTRY_CURRENCY,
  CURRENCY_GL,
  DISPLAY_CURRENCY_NOTE,
  resolveLocalCurrency,
  googleHotelsLocale,
  serpFetchCurrency,
  canConvertCurrency,
  convertRate,
  buildDisplayRateFields,
  attachDisplayRates,
};
