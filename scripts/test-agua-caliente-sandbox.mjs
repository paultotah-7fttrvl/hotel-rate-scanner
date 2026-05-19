#!/usr/bin/env node
/** Test Agua Caliente brand booking on sandbox (port 3001). */
const BASE = process.argv[2] || "http://localhost:3001";

const HOTELS = [
  { hotel: "Agua Caliente Resort Casino Spa Rancho Mirage", city: "Rancho Mirage" },
  { hotel: "Agua Caliente Casino Palm Springs", city: "Palm Springs" },
  { hotel: "Agua Caliente Casino Cathedral City", city: "Cathedral City" },
];

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  return res.json();
}

console.log(`\nAgua Caliente sandbox test — ${BASE}\n`);

const search = await get("/api/hotels/search?q=agua%20caliente");
console.log("Search 'agua caliente':", search.length || search.error, "results");
if (Array.isArray(search)) search.forEach(h => console.log("  •", h.name, "|", h.city));

for (const { hotel, city } of HOTELS) {
  const q = new URLSearchParams({ hotel, city, checkin: "2026-06-12", checkout: "2026-06-14", bust: "1" });
  const d = await get(`/api/rates?${q}`);
  const url = d.booking_url || "";
  const brand =
    url.includes("booking.com") ? "BOOKING.COM ✗" :
    url.includes("aguacaliente") || url.includes("secure-hotel-tracker") ? "brand ✓" :
    url ? "other" : "none";
  console.log(`\n${hotel}`);
  console.log(`  rate: $${d.rate ?? "—"}/night  (${d.rate_method || d.error || "—"})`);
  console.log(`  book: ${brand}`);
  console.log(`  url:  ${url.slice(0, 100)}${url.length > 100 ? "…" : ""}`);
}

console.log("");
