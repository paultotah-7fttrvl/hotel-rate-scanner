# Hotel Multi-Date Rate Scanner

A hotel rate comparison tool for flexible travelers. Search hotels worldwide, enter multiple date ranges, and compare average daily rates and total costs. Click "Book My Stay" to go directly to the hotel's booking page.

## Quick Start

No build step, no dependencies. Just open `index.html` in any browser:

```bash
# macOS
open index.html

# Windows
start index.html

# Linux
xdg-open index.html
```

That's it. The app loads React via CDN and runs entirely in the browser.

## How It Works

1. **Search** any city (Santa Barbara, Tokyo, Paris, Limerick, etc.)
2. **Select** 1-5 hotels from results
3. **Add** 2-10 check-in/check-out date pairs
4. **Compare** rates in a side-by-side table
5. **Book** by clicking through to the hotel's official website

## Current Status

| Feature | Status |
|---------|--------|
| Hotel search (80+ real hotels, 20 cities) | Working |
| Multi-date comparison | Working |
| Book My Stay (links to hotel websites) | Working |
| Rate data | **Demo (simulated)** |

## Connecting a Real Rate API

The demo uses simulated rates. To show real pricing, edit the `fetchRates()` function in `index.html`.

### Option A: SerpAPI (Google Hotels)

Sign up at [serpapi.com](https://serpapi.com). Their Google Hotels engine returns real rates.

```javascript
async function fetchRates(hotel, checkIn, checkOut) {
  const res = await fetch(
    `https://serpapi.com/search.json?engine=google_hotels` +
    `&q=${encodeURIComponent(hotel.name + ' ' + hotel.city)}` +
    `&check_in_date=${checkIn}&check_out_date=${checkOut}` +
    `&api_key=YOUR_SERPAPI_KEY`
  );
  const data = await res.json();
  const prop = data.properties?.[0];
  if (!prop) return { rate: hotel.baseRate, available: false };
  return {
    rate: prop.rate_per_night?.extracted_lowest || hotel.baseRate,
    available: true,
  };
}
```

### Option B: Amadeus Hotel Search API

Sign up at [developers.amadeus.com](https://developers.amadeus.com). Free tier available.

```javascript
// You'll need a backend proxy to hide your API key
async function fetchRates(hotel, checkIn, checkOut) {
  const res = await fetch(`/api/amadeus-rates?` + new URLSearchParams({
    cityCode: hotel.cityCode, // Add IATA codes to hotel DB
    checkIn,
    checkOut,
  }));
  const data = await res.json();
  const offer = data.data?.[0]?.offers?.[0];
  if (!offer) return { rate: hotel.baseRate, available: false };
  return {
    rate: Math.round(parseFloat(offer.price.total) / nightsBetween(checkIn, checkOut)),
    available: true,
  };
}
```

### Option C: Your Own Backend

Build a simple proxy that aggregates from any source:

```
GET /api/rates?hotel=Mar+Monte+Hotel&city=Santa+Barbara&checkIn=2026-04-10&checkOut=2026-04-13

Response:
{ "rate": 412, "available": true }
```

Then update `fetchRates()`:

```javascript
async function fetchRates(hotel, checkIn, checkOut) {
  const res = await fetch(`/api/rates?` + new URLSearchParams({
    hotel: hotel.name,
    city: hotel.city,
    checkIn,
    checkOut,
  }));
  return await res.json();
}
```

## Adding More Hotels

Add entries to the `HOTELS` array in `index.html`:

```javascript
{
  name: "Hotel Name",
  city: "City",
  region: "State/Country",
  stars: 4,
  baseRate: 250,        // Average USD/night (used as fallback)
  img: "\u{1F3E8}",     // Emoji icon
  url: "https://..."    // Direct booking URL
}
```

## File Structure

```
hotel-scanner/
  index.html    # Complete self-contained app (open in browser)
  README.md     # This file
```

## Tech Stack

Self-contained single HTML file:
- React 18 (via CDN)
- Babel standalone (JSX transform)
- DM Sans + DM Serif Display fonts
- Zero build tools, zero npm dependencies

## Architecture Notes for Production

To take this from prototype to production, you would:

1. **Rate API**: Connect SerpAPI, Amadeus, or build a scraper/aggregator backend
2. **Hotel DB**: Replace the static array with a database or the Amadeus Hotel List API
3. **Build system**: Move to Vite/Next.js if the codebase grows
4. **Tracking**: Add UTM parameters to booking links for conversion attribution
5. **Caching**: Cache rate lookups (rates change daily, not per-request)
6. **Auth**: Add user accounts for saved searches and price alerts (Phase 2)
