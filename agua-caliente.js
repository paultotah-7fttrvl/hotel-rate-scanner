/**
 * Agua Caliente Casinos — three Greater Palm Springs properties.
 * Hotel rooms book via PEGS (aguacalientecasinos.book.pegsbe.com) or secure-hotel-tracker.
 */

const AGUA_CALIENTE_PROPERTIES = [
  {
    id: "ac-rancho-mirage",
    displayName: "Agua Caliente Resort Casino Spa Rancho Mirage",
    city: "Rancho Mirage",
    cityKeys: ["rancho mirage", "palm desert"],
    serpNamePatterns: [/agua caliente.*rancho mirage/i, /agua caliente resort casino spa/i],
    hotelTrackerHid: "216429",
    propertyPage: "https://www.aguacalientecasinos.com/resort/",
    bookUrl: "https://aguacalientecasinos.book.pegsbe.com/",
  },
  {
    id: "ac-palm-springs",
    displayName: "Agua Caliente Casino Palm Springs",
    city: "Palm Springs",
    cityKeys: ["palm springs"],
    serpNamePatterns: [/agua caliente.*palm springs/i],
    propertyPage: "https://www.aguacalientecasinos.com/properties/palm-springs/",
    bookUrl: "https://aguacalientecasinos.book.pegsbe.com/",
  },
  {
    id: "ac-cathedral-city",
    displayName: "Agua Caliente Casino Cathedral City",
    city: "Cathedral City",
    cityKeys: ["cathedral city"],
    serpNamePatterns: [/agua caliente.*cathedral/i],
    propertyPage: "https://www.aguacalientecasinos.com/properties/cathedral-city/",
    bookUrl: "https://aguacalientecasinos.book.pegsbe.com/",
  },
];

const BRAND_HOST_FRAGMENTS = [
  "aguacalientecasinos.com",
  "aguacalientecasinos.book.pegsbe.com",
  "secure-hotel-tracker.com",
];

function normalizeBlob(hotelName, city) {
  return `${hotelName || ""} ${city || ""}`.toLowerCase().replace(/\s+/g, " ").trim();
}

function isAguaCalienteQuery(hotelName, city) {
  return /agua\s*caliente/i.test(normalizeBlob(hotelName, city));
}

function resolveAguaCalienteProperty(hotelName, city) {
  const blob = normalizeBlob(hotelName, city);
  if (!/agua\s*caliente/i.test(blob)) return null;

  for (const prop of AGUA_CALIENTE_PROPERTIES) {
    if (prop.cityKeys.some(k => blob.includes(k))) return prop;
    if (prop.serpNamePatterns.some(re => re.test(blob))) return prop;
  }

  if (/rancho|mirage|palm desert/i.test(blob)) {
    return AGUA_CALIENTE_PROPERTIES.find(p => p.id === "ac-rancho-mirage");
  }
  if (/palm springs/i.test(blob)) {
    return AGUA_CALIENTE_PROPERTIES.find(p => p.id === "ac-palm-springs");
  }
  if (/cathedral/i.test(blob)) {
    return AGUA_CALIENTE_PROPERTIES.find(p => p.id === "ac-cathedral-city");
  }

  return null;
}

function matchesAguaCalienteProperty(serpName, prop) {
  if (!serpName || !prop) return false;
  return prop.serpNamePatterns.some(re => re.test(serpName));
}

function isAguaCalienteBrandUrl(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  return BRAND_HOST_FRAGMENTS.some(h => u.includes(h));
}

function nightsBetween(checkIn, checkOut) {
  const a = new Date(checkIn);
  const b = new Date(checkOut);
  return Math.max(1, Math.round((b - a) / 86400000));
}

/** Official PEGS room search — same format as aguacalientecasinos.com “Book a Room”. */
function buildPegsbeRoomsUrl(checkIn, checkOut, currency = "USD") {
  if (!checkIn || !checkOut) return "https://aguacalientecasinos.book.pegsbe.com/rooms";
  const params = new URLSearchParams({
    locale: "en",
    offerCode: "",
    flow: "tf",
    Rooms: "1",
    CheckinDate: checkIn,
    LOS: String(nightsBetween(checkIn, checkOut)),
    Adults_1: "2",
    Children_1: "0",
    iataNumber: "",
    Currency: currency,
    multi: "false",
    accessCode: "",
  });
  return `https://aguacalientecasinos.book.pegsbe.com/rooms?${params.toString()}`;
}

function withHotelTrackerDates(url, checkIn, checkOut) {
  if (!url || !checkIn || !checkOut) return url;
  try {
    const u = new URL(url);
    if (u.hostname.includes("secure-hotel-tracker.com")) {
      u.searchParams.set("checkin", checkIn);
      u.searchParams.set("checkout", checkOut);
      return u.toString();
    }
  } catch {
    /* keep original */
  }
  return url;
}

function buildAguaCalienteBookingUrl(prop, checkIn, checkOut, decodedBrandLink, currency = "USD") {
  if (!checkIn || !checkOut) {
    return prop?.propertyPage || "https://www.aguacalientecasinos.com/";
  }

  if (decodedBrandLink?.includes("book.pegsbe.com")) {
    return buildPegsbeRoomsUrl(checkIn, checkOut, currency);
  }
  if (decodedBrandLink?.includes("secure-hotel-tracker.com")) {
    return withHotelTrackerDates(decodedBrandLink, checkIn, checkOut);
  }

  return buildPegsbeRoomsUrl(checkIn, checkOut, currency);
}

function curatedHotelsForSearch(excludeIds = new Set()) {
  return AGUA_CALIENTE_PROPERTIES.filter(p => !excludeIds.has(p.id)).map(p => ({
    id: p.id,
    name: p.displayName,
    city: p.city,
    region: "California, US",
    stars: 4,
    url: p.propertyPage,
    chain: "aguacaliente",
    aguaCalienteId: p.id,
  }));
}

module.exports = {
  AGUA_CALIENTE_PROPERTIES,
  isAguaCalienteQuery,
  resolveAguaCalienteProperty,
  matchesAguaCalienteProperty,
  isAguaCalienteBrandUrl,
  buildAguaCalienteBookingUrl,
  curatedHotelsForSearch,
  buildPegsbeRoomsUrl,
  withHotelTrackerDates,
};
