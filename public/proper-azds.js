/**
 * AZDS booking-engine URL encoder (Proper Hotels / newbooking.azds.com).
 * Reverse-engineered from the boutique-gallery booking widget crush codec.
 */
(function (global) {
  const m = (z, a = 1) => {
    const A = [
      ['"', "'"],
      ["':", "!"],
      [",'", "~"],
      ["}", ")", "\\", "\\"],
      ["{", "(", "\\", "\\"],
    ];
    const S = (R, L) => {
      const F = new RegExp(`${(L[2] ? L[2] : "") + L[0]}|${(L[3] ? L[3] : "") + L[1]}`, "g");
      return R.replace(F, (B) => (B === L[0] ? L[1] : L[0]));
    };
    if (a) for (let R = 0; R < A.length; ++R) z = S(z, A[R]);
    else for (let R = A.length; R--;) z = S(z, A[R]);
    return z;
  };

  const crush = (z, a = 50) => {
    const R = [];
    for (let W = 127; --W; )
      (W >= 48 && W <= 57) ||
      (W >= 65 && W <= 90) ||
      (W >= 97 && W <= 122) ||
      "-_.!~*'()".includes(String.fromCharCode(W))
        ? R.push(String.fromCharCode(W))
        : 0;
    for (let W = 32; W < 255; ++W) {
      const j = String.fromCharCode(W);
      if (j != "\\" && !R.includes(j)) R.unshift(j);
    }
    z = z.replace(/\x01/g, "");
    const F = ((W, j) => {
      let Q = j.length,
        se = "";
      const ne = (ge) => encodeURI(encodeURIComponent(ge)).replace(/%../g, "i").length,
        Ee = (ge) => {
          const Ae = ge.charCodeAt(0),
            Z = ge.charCodeAt(ge.length - 1);
          return (Ae >= 56320 && Ae <= 57343) || (Z >= 55296 && Z <= 56319);
        };
      let me = {};
      for (let ge = 2; ge < a; ge++)
        for (let Ae = 0; Ae < W.length - ge; ++Ae) {
          const Z = W.substr(Ae, ge);
          if (me[Z] || Ee(Z)) continue;
          let ee = 1;
          for (let de = W.indexOf(Z, Ae + ge); de >= 0; ++ee) de = W.indexOf(Z, de + ge);
          ee > 1 && (me[Z] = ee);
        }
      for (;;) {
        for (; Q-- && W.includes(j[Q]); );
        if (Q < 0) break;
        let Ae,
          ge = j[Q],
          Z = 0,
          ee = ne(ge);
        for (const qe in me) {
          const $e = me[qe];
          let Ot = ($e - 1) * ne(qe) - ($e + 1) * ee;
          if (!se.length) Ot -= ne("\x01");
          Ot <= 0 ? delete me[qe] : Ot > Z && ((Ae = qe), (Z = Ot));
        }
        if (!Ae) break;
        W = W.split(Ae).join(ge) + ge + Ae;
        se = ge + se;
        const de = {};
        for (const qe in me) {
          const $e = qe.split(Ae).join(ge);
          let Ot = 0;
          for (let mt = W.indexOf($e); mt >= 0; ++Ot) mt = W.indexOf($e, mt + $e.length);
          Ot > 1 && (de[$e] = Ot);
        }
        me = de;
      }
      return { a: W, b: se };
    })(m(z), R);
    let B = F.a;
    return F.b.length && (B += "\x01" + F.b), B + "_", B;
  };

  const uncrush = (z) => {
    const a = (z = z.substring(0, z.length - 1)).split("\x01");
    let A = a[0];
    if (a.length > 1) {
      const S = a[1];
      for (const R of S) {
        const L = A.split(R);
        A = L.join(L.pop());
      }
    }
    return m(A, 0);
  };

  const ATTRS = [
    "hotels", "hotelId", "arrive", "depart", "currency", "accessible", "destinationSettings",
    "price", "min", "max", "locations", "areas", "sort", "filters", "filter", "options",
    "reservationItems", "roomCategories", "serviceCodes", "roomsOrder", "cendynConfirmationCode",
    "nightlyPrice", "adults", "children", "childAge", "promo", "coupon", "group", "ratePlan",
    "activeHotelIndex", "modify", "subSourceCode", "email", "reservationId", "lastName", "submit",
    "reservationQuery", "redirectLink", "hotelCodes", "exclusiveHotelCode",
  ];

  function genKeyMap() {
    const u = [],
      encodeMap = {},
      decodeMap = {};
    for (const g of ATTRS) {
      let key = "",
        f = g.length - 1;
      for (; !key; )
        if (((key = g[0] + g[f]), u.includes(key) && (f--, (key = "")), f === 0))
          throw new Error("BEDecoderService/genKeyMap: attribute naming collision");
      u.push(key);
      encodeMap[g] = key;
      decodeMap[key] = g;
    }
    return [encodeMap, decodeMap];
  }

  const [encodeMap, decodeMap] = genKeyMap();

  function formatUsDate(iso) {
    const [y, m, d] = iso.split("-");
    return `${m}/${d}/${y}`;
  }

  function encodeMapper(obj, g) {
    const out = {};
    (Array.isArray(obj) ? obj : Object.keys(obj)).forEach((p) => {
      const C = obj[p];
      const mk =
        C instanceof Date
          ? formatUsDate(C.toISOString().slice(0, 10))
          : Array.isArray(C)
            ? C.map((y) =>
                Array.isArray(y) || (y && typeof y === "object" && !Array.isArray(y))
                  ? encodeMapper(y, g)
                  : y
              )
            : C && typeof C === "object" && !Array.isArray(C)
              ? encodeMapper(C, g)
              : C;
      out[g[p]] = mk;
    });
    return out;
  }

  function decodeMapper(obj, g) {
    const out = {};
    (Array.isArray(obj) ? obj : Object.keys(obj)).forEach((p) => {
      const C = obj[p];
      out[g[p]] =
        Array.isArray(C)
          ? C.map((y) =>
              Array.isArray(y) || (y && typeof y === "object" && !Array.isArray(y))
                ? decodeMapper(y, g)
                : y
            )
          : C && typeof C === "object" && !Array.isArray(C)
            ? decodeMapper(C, g)
            : C;
    });
    return out;
  }

  function buildState(hotelId, checkIn, checkOut) {
    const arrive = checkIn ? formatUsDate(checkIn) : null;
    const depart = checkOut ? formatUsDate(checkOut) : null;
    return {
      hotels: [
        {
          hotelId,
          arrive,
          depart,
          filters: [],
          reservationItems: [
            {
              adults: 2,
              children: 0,
              childAge: [],
              accessible: false,
              promo: null,
              coupon: null,
              group: null,
              ratePlan: [],
            },
          ],
          reservationQuery: null,
          redirectLink: null,
          roomCategories: [],
          roomsOrder: null,
          serviceCodes: [],
        },
      ],
      activeHotelIndex: 0,
      currency: null,
      destinationSettings: {
        price: null,
        locations: null,
        areas: null,
        sort: null,
        hotelCodes: null,
        exclusiveHotelCode: null,
      },
      modify: false,
      subSourceCode: null,
      cendynConfirmationCode: null,
      nightlyPrice: null,
    };
  }

  function encode(state) {
    try {
      const payload = crush(JSON.stringify(encodeMapper(state, encodeMap)));
      return payload.endsWith("_") ? payload : payload + "_";
    } catch (e) {
      console.warn("[ProperAzds] encode failed", e);
      return null;
    }
  }

  function decode(data) {
    try {
      return decodeMapper(JSON.parse(uncrush(data)), decodeMap);
    } catch (e) {
      console.warn("[ProperAzds] decode failed", e);
      return null;
    }
  }

  /** Patch dates on an existing AZDS payload (keeps compression stable when possible). */
  function patchDates(data, checkIn, checkOut) {
    const state = decode(data);
    if (!state?.hotels?.[0]) return null;
    state.hotels[0].arrive = formatUsDate(checkIn);
    state.hotels[0].depart = formatUsDate(checkOut);
    return encode(state);
  }

  function isBrokenPayload(data) {
    return !data || /ae!'|dt!'/.test(data);
  }

  function extractDataParam(url) {
    if (!url) return null;
    const m = url.match(/data=([^&]+)/);
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return null;
    }
  }

  function hasValidBookingData(url) {
    const raw = extractDataParam(url);
    return !!(raw && raw.length > 80 && raw.includes("proper-") && !isBrokenPayload(raw));
  }

  function stateMatchesDates(state, checkIn, checkOut) {
    if (!state?.hotels?.[0] || !checkIn || !checkOut) return false;
    const h = state.hotels[0];
    return h.arrive === formatUsDate(checkIn) && h.depart === formatUsDate(checkOut);
  }

  function urlMatchesScannerDates(url, checkIn, checkOut) {
    if (!hasValidBookingData(url)) return false;
    const raw = extractDataParam(url);
    if (!raw) return false;
    const state = decode(raw);
    return stateMatchesDates(state, checkIn, checkOut);
  }

  /**
   * Build a Proper Hotels booking URL with scanner dates (step-2 = rooms).
   * Always encodes check-in/check-out from the scanner first — SerpAPI links often
   * point at step-1 without dates and must not be reused verbatim.
   */
  function buildBookingUrl(path, hotelId, checkIn, checkOut, serpUrl) {
    const base = `https://www.properhotel.com/${path}/#/booking`;
    const stepUrl = (step, data) => `${base}/${step}?data=${encodeURIComponent(data)}`;

    if (checkIn && checkOut) {
      if (urlMatchesScannerDates(serpUrl, checkIn, checkOut)) {
        return serpUrl.includes("/step-2") ? serpUrl : stepUrl("step-2", extractDataParam(serpUrl));
      }

      const data = encode(buildState(hotelId, checkIn, checkOut));
      if (data && !isBrokenPayload(data)) {
        return stepUrl("step-2", data);
      }

      const raw = extractDataParam(serpUrl);
      if (raw && !isBrokenPayload(raw)) {
        const patched = patchDates(raw, checkIn, checkOut);
        if (patched && !isBrokenPayload(patched)) {
          return stepUrl("step-2", patched);
        }
      }
    }

    const fallback = encode(buildState(hotelId, null, null));
    if (fallback) return stepUrl("step-1", fallback);
    return `${base}/step-1`;
  }

  global.ProperAzds = {
    buildState,
    encode,
    decode,
    patchDates,
    formatUsDate,
    isBrokenPayload,
    hasValidBookingData,
    urlMatchesScannerDates,
    extractDataParam,
    buildBookingUrl,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = globalThis.ProperAzds;
}
