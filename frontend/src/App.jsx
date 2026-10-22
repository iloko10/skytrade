import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { API, api, toResult } from "./api.js";
import { RAW_AIRPORTS, RAW_ROUTES, RAW_CARRIERS, RAW_AIRLINES } from "./airportData.js";

/* =====================================================================
   SkyTrade — real airports, real nonstop routes, real airlines.
   Data: OpenFlights (1.486 airports with scheduled service, every Greek
   and Cypriot airport, ~34.000 nonstop pairs, airline codes per airport).
   Fares are modelled from real great-circle distance and how many
   carriers actually fly the pair — swap in a live API for real prices.
   ===================================================================== */



/* ---------- parse ---------- */
const AIRPORTS = {};
RAW_AIRPORTS.split(";").forEach((s) => {
  const [code, city, country, la, lo, enCity, enCountry] = s.split("|");
  AIRPORTS[code] = { code, city, country, lat: +la, lon: +lo, enCity, enCountry };
});
const ROUTES = {};
RAW_ROUTES.split(";").forEach((s) => {
  const o = s.slice(0, 3); const arr = [];
  for (let i = 3; i < s.length; i += 3) arr.push(s.slice(i, i + 3));
  ROUTES[o] = arr;
});
const ROUTESET = {};
Object.keys(ROUTES).forEach((k) => { ROUTESET[k] = new Set(ROUTES[k]); });
const CARRIERS_AT = {};
RAW_CARRIERS.split(";").forEach((s) => { CARRIERS_AT[s.slice(0, 3)] = s.slice(3).split(","); });
const AIRLINE = {};
RAW_AIRLINES.split(";").forEach((s) => { const [c, n] = s.split("|"); AIRLINE[c] = n; });
const CODES = Object.keys(AIRPORTS);
// lower-case and strip accents so Τίρανα / τιρανα / Tirana all compare equal
const norm = (t) => (t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

const LOWCOST = new Set(["FR", "U2", "W6", "V7", "HV", "VY", "DY", "PC", "EW", "BE", "SX", "XQ", "G9", "FZ", "LS", "TO", "ZB", "NK", "F9", "WN", "AK", "JQ", "6E", "SG", "TR", "XC", "0B", "GQ", "BV", "IG", "NO"]);

/* ---------- helpers ---------- */
const eur = (n) => "€" + Math.round(n);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r5 = (n) => Math.round(n / 5) * 5;
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const rnd = (n) => { let t = (n + 0x6d2b79f5) >>> 0; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ymd = (d) => d.toISOString().slice(0, 10);
const TODAY = new Date();
const addDays = (n) => new Date(TODAY.getTime() + n * 86400000);
const hm = (m) => `${Math.floor(m / 60)}ω ${String(Math.round(m % 60)).padStart(2, "0")}λ`;
const clock = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(Math.round(m % 60)).padStart(2, "0")}`;
const city = (c) => AIRPORTS[c]?.city || c;

function km(a, b) {
  const A = AIRPORTS[a], B = AIRPORTS[b];
  if (!A || !B) return 500;
  const R = 6371, p = Math.PI / 180;
  const dLat = (B.lat - A.lat) * p, dLon = (B.lon - A.lon) * p;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(A.lat * p) * Math.cos(B.lat * p) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const carriersFor = (o, d) => {
  const a = CARRIERS_AT[o] || [], bl = CARRIERS_AT[d] || [], b = new Set(bl);
  let list = a.filter((c) => b.has(c));
  if (list.length < 3) {
    const far = km(o, d) > 3000;                      // no budget carrier on a long haul
    const extra = [...bl, ...a].filter((c) => !list.includes(c) && (!far || !LOWCOST.has(c)));
    list = [...list, ...extra];
  }
  return [...new Set(list)].slice(0, 5);
};

/* distance-based fare, adjusted for competition, season and lead time */
function dayPrice(origin, dest, date) {
  const d = km(origin, dest);
  let base = 32 + (d <= 1500 ? d * 0.075 : 1500 * 0.075 + (d <= 5000 ? (d - 1500) * 0.048 : 3500 * 0.048 + (d - 5000) * 0.032));
  const comp = carriersFor(origin, dest).length;
  base *= 1.3 - Math.min(comp, 5) * 0.06;
  if (!ROUTESET[origin]?.has(dest)) base *= 1.18;              // connecting trips price higher
  const daysOut = Math.max(1, Math.round((date - TODAY) / 86400000));
  const seasonal = 0.84 + rnd(hash(origin + dest + ymd(date))) * 0.5;
  const dow = date.getDay();
  const weekend = dow === 5 || dow === 0 ? 1.13 : dow === 2 || dow === 3 ? 0.91 : 1;
  const near = daysOut < 10 ? 1.34 : daysOut < 21 ? 1.12 : 1;
  return r5(base * seasonal * weekend * near);
}

const flightMinutes = (a, b) => 35 + km(a, b) / 13.2;
const MULT = [0.68, 0.78, 0.88, 1, 1.16, 1.34, 1.55];

const walks = new Map();
function walkIdx(key, tick, n) {
  let arr = walks.get(key);
  if (!arr) { arr = [3]; walks.set(key, arr); }
  const h = hash(key);
  while (arr.length <= tick) {
    const r = rnd(h + arr.length * 977);
    let i = arr[arr.length - 1];
    if (r < 0.22) i--; else if (r < 0.44) i++;
    arr.push(clamp(i, 0, n - 1));
  }
  return arr[tick];
}

function connections(o, d) {
  const from = ROUTES[o] || [];
  const hubs = from.filter((h) => h !== d && ROUTESET[h]?.has(d));
  return hubs.map((h) => ({ h, detour: km(o, h) + km(h, d) - km(o, d) }))
    .sort((a, b) => a.detour - b.detour).slice(0, 6).map((x) => x.h);
}

function buildResults(origin, dest, date, tick) {
  if (!AIRPORTS[origin] || !AIRPORTS[dest] || origin === dest) return [];
  const dp = dayPrice(origin, dest, date);
  const cs = carriersFor(origin, dest);
  const direct = ROUTESET[origin]?.has(dest);
  const out = [];

  const make = (key, carrier, variant, stops, via) => {
    const s = hash(key);
    const lowcost = LOWCOST.has(carrier);
    const cf = (lowcost ? 0.82 : 1.12) * [1, 0.94, 1.08][variant];
    const buckets = MULT.map((m) => r5(dp * cf * (stops ? 0.92 : 1) * m));
    const idx = walkIdx(key, tick, buckets.length);
    const depM = (5 + Math.floor(rnd(s) * 17)) * 60 + Math.floor(rnd(s + 1) * 12) * 5;
    const leg1 = flightMinutes(origin, via || dest);
    const layover = stops ? 55 + Math.floor(rnd(s + 9) * 120) : 0;
    const leg2 = stops ? flightMinutes(via, dest) : 0;
    return {
      id: key, carrier, airline: AIRLINE[carrier] || carrier, lowcost,
      code: `${carrier} ${100 + Math.floor(rnd(s + 5) * 8000)}`,
      depM, dur: leg1 + layover + leg2, arrM: depM + leg1 + layover + leg2,
      stops, via, layover, leg1, leg2,
      price: buckets[idx], buckets,
      history: Array.from({ length: 40 }, (_, k) => buckets[walkIdx(key, Math.max(0, tick - 39 + k), buckets.length)]),
      seatsLeft: 1 + Math.floor(rnd(s + 17) * 9),
    };
  };

  if (direct) {
    cs.forEach((c) => { for (let v = 0; v < 2; v++) out.push(make(`${origin}|${dest}|${ymd(date)}|${c}|${v}`, c, v, 0, null)); });
  }
  const longHaul = km(origin, dest) > 4000;
  const hubs = connections(origin, dest).slice(0, direct ? 2 : 5);
  hubs.forEach((h, i) => {
    // a carrier that actually serves both legs, and no low-cost on long haul
    const first = carriersFor(origin, h), second = carriersFor(h, dest);
    let pool = first.filter((c) => second.includes(c));
    if (longHaul) pool = pool.filter((c) => !LOWCOST.has(c));
    if (!pool.length) pool = (longHaul ? second.filter((c) => !LOWCOST.has(c)) : second);
    if (!pool.length) pool = second.length ? second : cs;
    const c = pool[i % pool.length] || "A3";
    out.push(make(`${origin}|${dest}|${ymd(date)}|${c}|x${h}`, c, i % 3, 1, h));
  });
  if (!out.length) {
    const c = (CARRIERS_AT[origin] || ["A3"])[0];
    out.push(make(`${origin}|${dest}|${ymd(date)}|${c}|solo`, c, 0, 1, (ROUTES[origin] || ["FRA"])[0]));
  }
  return out;
}

function outlook(history, current) {
  const sorted = [...history].sort((a, b) => a - b);
  const p25 = sorted[Math.floor(sorted.length * 0.25)];
  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : current);
  const delta = avg(history.slice(-12)) - avg(history.slice(-28, -12));
  const dir = delta > current * 0.02 ? "rising" : delta < -current * 0.02 ? "falling" : "flat";
  return {
    dir, low: Math.min(...history), suggested: r5(Math.min(p25, current * 0.92)),
    conf: Math.round(64 + rnd(hash(String(current))) * 28),
    msg: {
      rising: "Η τιμή ανεβαίνει τις τελευταίες μέρες. Αν σε βολεύει η ημερομηνία, κλείσ' το τώρα.",
      falling: "Η τιμή πέφτει. Βάλε limit και άσε μας να το πιάσουμε χαμηλότερα.",
      flat: "Η τιμή είναι σταθερή. Ένα limit λίγο πιο κάτω πιάνει συνήθως μια βουτιά.",
    }[dir],
  };
}

/* ============================ styles ============================ */
const CSS = `
:root{--blue:#0062E3;--blue-d:#0050BC;--navy:#05203C;--grey:#626971;--line:#DCE0E5;--bg:#F1F2F4;--white:#fff;--teal:#00807A;--orange:#E8590C;--orange-s:#FFF4EC}
*{box-sizing:border-box}
.st{font-family:'Inter','Segoe UI',system-ui,-apple-system,sans-serif;color:var(--navy);background:var(--bg);min-height:100vh}
.wrap{max-width:1120px;margin:0 auto;padding:0 16px}
.hdr{background:var(--white);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:30}
.hdr-in{display:flex;align-items:center;gap:20px;height:60px}
.logo{font-size:20px;font-weight:800;letter-spacing:-.5px;cursor:pointer}
.logo span{color:var(--blue)}
.nav{display:flex;gap:4px}
.nav button{background:none;border:none;font:inherit;font-size:14px;font-weight:600;color:var(--grey);padding:8px 12px;border-radius:8px;cursor:pointer}
.nav button:hover{background:var(--bg)}
.nav button.on{color:var(--navy);background:#E8F0FE}
.pill{margin-left:auto;display:flex;align-items:center;gap:10px;font-size:13px;color:var(--grey)}
.avatar{width:32px;height:32px;border-radius:50%;background:var(--navy);color:#fff;display:grid;place-items:center;font-size:12px;font-weight:700}
.hero{background:var(--navy);padding:34px 0 76px;color:#fff}
.hero h1{font-size:31px;line-height:1.2;font-weight:800;margin:0 0 6px;letter-spacing:-.6px}
.hero p{margin:0;font-size:15px;color:#A9BBD0}
.panel{background:var(--white);border-radius:14px;box-shadow:0 6px 24px rgba(5,32,60,.14);padding:14px;margin-top:-54px;position:relative;z-index:2}
.tabs{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}
.tab{background:none;border:1px solid var(--line);border-radius:999px;padding:6px 14px;font:inherit;font-size:13px;font-weight:600;color:var(--grey);cursor:pointer}
.tab.on{background:var(--navy);border-color:var(--navy);color:#fff}
.fields{display:grid;grid-template-columns:1.2fr 1.2fr 1fr .8fr auto;gap:8px}
.field{border:1px solid var(--line);border-radius:10px;padding:8px 12px;text-align:left;background:var(--white);cursor:pointer;font:inherit;width:100%}
.field:hover{border-color:var(--blue)}
.field label{display:block;font-size:11px;font-weight:700;color:var(--grey);text-transform:uppercase;letter-spacing:.4px}
.field .val{font-size:15px;font-weight:600;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.field .sub{font-size:11.5px;color:var(--grey);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.go{background:var(--blue);color:#fff;border:none;border-radius:10px;padding:0 26px;font:inherit;font-size:15px;font-weight:700;cursor:pointer}
.go:hover{background:var(--blue-d)}
.sec-h{font-size:20px;font-weight:800;margin:30px 0 4px;letter-spacing:-.3px}
.sec-p{font-size:13.5px;color:var(--grey);margin:0 0 14px}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(178px,1fr));gap:12px}
.tile{background:var(--white);border:1px solid var(--line);border-radius:12px;overflow:hidden;cursor:pointer;text-align:left;font:inherit;color:inherit;transition:transform .12s ease,box-shadow .12s ease}
.tile:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(5,32,60,.1)}
.tile .sky{height:104px;position:relative;overflow:hidden;background:#dfe4e9}
.tile .sky img{width:100%;height:100%;object-fit:cover;display:block}
.tile .skylabel{position:absolute;left:11px;bottom:9px;color:#fff;font-weight:800;font-size:16px;text-shadow:0 1px 6px rgba(0,0,0,.45)}
.tile .body{padding:10px 12px}
.tile .row{display:flex;justify-content:space-between;align-items:baseline}
.muted{color:var(--grey);font-size:12px}
.price{font-size:17px;font-weight:800}
.bar{background:var(--white);border-bottom:1px solid var(--line);padding:12px 0;position:sticky;top:60px;z-index:20}
.bar-in{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.bar h2{font-size:17px;font-weight:800;margin:0}
.link{background:none;border:none;font:inherit;color:var(--blue);font-weight:600;cursor:pointer;padding:0;font-size:13.5px}
.sorts{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:16px 0}
.sort{background:var(--white);border:1px solid var(--line);border-radius:10px;padding:10px 12px;cursor:pointer;font:inherit;text-align:left}
.sort.on{border-color:var(--navy);box-shadow:inset 0 0 0 1px var(--navy)}
.sort b{display:block;font-size:13.5px}
.sort span{font-size:12px;color:var(--grey)}
.cols{display:grid;grid-template-columns:224px 1fr;gap:20px;align-items:start;padding-bottom:50px}
.filters{background:var(--white);border:1px solid var(--line);border-radius:12px;padding:14px;position:sticky;top:132px}
.fgroup{padding:12px 0;border-top:1px solid var(--line)}
.fgroup:first-of-type{border-top:none;padding-top:0}
.fgroup h4{margin:0 0 8px;font-size:13px;font-weight:700}
.chk{display:flex;align-items:center;gap:9px;padding:5px 0;font-size:13px;cursor:pointer}
.chk input{accent-color:var(--blue);width:15px;height:15px}
.chk .r{margin-left:auto;color:var(--grey);font-size:12px}
input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:4px;background:var(--line);border-radius:3px;outline:none}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:var(--blue);border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.25);cursor:pointer}
input[type=range]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:var(--blue);border:3px solid #fff;cursor:pointer}
.res{background:var(--white);border:1px solid var(--line);border-radius:12px;margin-bottom:10px;overflow:hidden}
.res:hover{border-color:#B9C3CE}
.res-in{display:grid;grid-template-columns:1fr 168px}
.leg{padding:16px;display:flex;align-items:center;gap:14px}
.mark{width:34px;height:34px;border-radius:8px;display:grid;place-items:center;color:#fff;font-size:11px;font-weight:800;flex:none}
.times{display:flex;align-items:center;gap:12px;flex:1;min-width:0}
.t{font-size:18px;font-weight:800;letter-spacing:-.3px}
.t small{display:block;font-size:11.5px;font-weight:500;color:var(--grey)}
.path{flex:1;text-align:center;min-width:76px}
.path .d{font-size:11.5px;color:var(--grey)}
.pathline{position:relative;height:1px;background:var(--line);margin:6px 0}
.pathline i{position:absolute;top:-2px;width:5px;height:5px;border-radius:50%;background:var(--grey)}
.buy{border-left:1px solid var(--line);padding:14px;display:flex;flex-direction:column;justify-content:center;gap:8px;background:#FBFCFD}
.btn{border:none;border-radius:8px;padding:10px 12px;font:inherit;font-size:13.5px;font-weight:700;cursor:pointer;width:100%}
.btn-blue{background:var(--blue);color:#fff}
.btn-blue:hover{background:var(--blue-d)}
.btn-line{background:#fff;border:1px solid var(--line);color:var(--navy)}
.btn-orange{background:var(--orange);color:#fff}
.limitbar{border-top:1px dashed var(--line);background:var(--orange-s);padding:9px 16px;display:flex;align-items:center;gap:8px;font-size:12.5px;color:#8A3B00;flex-wrap:wrap}
.tag{display:inline-block;font-size:11px;font-weight:700;padding:2px 7px;border-radius:5px}
.tag-green{background:#E3F6F4;color:var(--teal)}
.tag-red{background:#FDECEA;color:#C0341D}
.tag-grey{background:#EEF1F4;color:var(--grey)}
.card{background:var(--white);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px}
.h3{font-size:16px;font-weight:800;margin:0 0 4px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.kv{background:#F7F9FB;border-radius:9px;padding:10px 12px}
.kv label{font-size:11px;color:var(--grey);font-weight:600;text-transform:uppercase;letter-spacing:.4px}
.kv div{font-size:17px;font-weight:800;margin-top:2px}
.inp{width:100%;border:1px solid var(--line);border-radius:9px;padding:11px 12px;font:inherit;font-size:14px;margin-top:5px;background:#fff}
.inp:focus{outline:2px solid var(--blue);outline-offset:-1px}
.lbl{font-size:12px;font-weight:700;color:var(--grey)}
.aprow{display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:var(--white);border:1px solid var(--line);border-radius:10px;padding:11px 14px;margin-bottom:7px;cursor:pointer;font:inherit;color:inherit}
.aprow:hover{border-color:var(--blue);background:#F7FAFF}
.cal{display:grid;grid-template-columns:repeat(7,1fr);gap:5px}
.cal button{border:1px solid transparent;border-radius:9px;background:none;font:inherit;padding:8px 2px;cursor:pointer;color:var(--navy)}
.cal button:disabled{color:#C7CDD4;cursor:default}
.cal button .n{font-size:13px;font-weight:700}
.cal button .p{font-size:10.5px;color:var(--grey);margin-top:2px}
.cal button.cheap{background:#E3F6F4}
.cal button.cheap .p{color:var(--teal);font-weight:700}
.cal button.sel{background:var(--navy);color:#fff}
.cal button.sel .p{color:#B9C9DC}
.toast{position:fixed;left:50%;transform:translateX(-50%);bottom:22px;background:var(--navy);color:#fff;border-radius:10px;padding:13px 18px;font-size:13.5px;font-weight:600;box-shadow:0 8px 26px rgba(5,32,60,.3);z-index:60}
.mobile-only{display:none}
@media(max-width:860px){
 .fields{grid-template-columns:1fr 1fr}.go{grid-column:1/-1;padding:12px}
 .cols{grid-template-columns:1fr}.filters{position:static}
 .mobile-only{display:block}.desk-only{display:none}
 .res-in{grid-template-columns:1fr}.buy{border-left:none;border-top:1px solid var(--line);flex-direction:row}
 .hero h1{font-size:25px}
}
`;

/* ============================ city artwork ============================
   Real photos: put a URL next to an airport code and the tile uses it.
   const PHOTOS = { NAP: "https://your-cdn/naples.jpg" }  */
const PHOTOS = {};
const ART_ALIAS = { LHR: "LGW", STN: "LGW", LTN: "LGW", LCY: "LGW", ORY: "CDG", BVA: "CDG", CIA: "FCO", SAW: "IST", LIN: "MXP", BGY: "MXP", PFO: "LCA" };
const SKY = {
  FCO: ["#FFC48A", "#E2653C"], NAP: ["#FFD08A", "#D9484F"], MXP: ["#CFE0EE", "#5B7F9E"], BCN: ["#FFD59E", "#E07A4C"],
  MAD: ["#FFCF7E", "#C9553D"], LGW: ["#C6D6E4", "#5A6E84"], MAN: ["#B9C8D6", "#4E6274"], CDG: ["#E7C8DC", "#7A5C86"],
  AMS: ["#CADCE9", "#51789B"], BER: ["#D3DCE6", "#5C6B7D"], MUC: ["#CFE2E8", "#5E8497"], VIE: ["#EBD5C0", "#8A6A5C"],
  PRG: ["#E5CBB3", "#8A6247"], IST: ["#FFCB94", "#C4623F"], LCA: ["#A9E4F0", "#2E8AA8"], JTR: ["#9FE0F2", "#2C7FA6"],
  HER: ["#BFE6EA", "#3B8395"], RHO: ["#FFDDA1", "#D68B45"], ATH: ["#FFD9A0", "#C97F45"], SKG: ["#BFD4E4", "#4E7391"],
};
const INK = "#16283D";
const LANDMARK = {
  ATH: () => (<g fill={INK}><path d="M56 92V64h88v28z" /><path d="M52 64h96l-48-16z" />{[0, 1, 2, 3, 4, 5].map((i) => <rect key={i} x={62 + i * 15} y="64" width="8" height="28" fill="#fff" opacity=".18" />)}</g>),
  SKG: () => (<g fill={INK}><path d="M88 92V44h26v48z" /><path d="M101 30l8 14H93z" /><rect x="86" y="40" width="30" height="5" /><path d="M30 92h140" stroke={INK} strokeWidth="3" opacity=".4" /></g>),
  FCO: () => (<g fill={INK}><path d="M58 92V64a42 20 0 0 1 84 0v28z" /><g fill="#fff" opacity=".22">{[0, 1, 2, 3, 4].map((i) => <rect key={i} x={66 + i * 14} y="58" width="7" height="12" rx="3" />)}{[0, 1, 2, 3, 4].map((i) => <rect key={"b" + i} x={66 + i * 14} y="74" width="7" height="12" rx="3" />)}</g></g>),
  NAP: () => (<g fill={INK}><path d="M40 92 92 48l12 10 10-8 46 42z" /><path d="M86 52h18l-9-8z" fill="#E2653C" opacity=".5" /></g>),
  MXP: () => (<g fill={INK}><path d="M62 92V70h76v22z" />{[0, 1, 2, 3, 4, 5, 6].map((i) => <path key={i} d={`M${66 + i * 11} 70 l4.5 ${-14 - (i === 3 ? 16 : 0)} l4.5 ${14 + (i === 3 ? 16 : 0)}z`} />)}</g>),
  BCN: () => (<g fill={INK}><path d="M62 92V72h76v20z" />{[0, 1, 2, 3].map((i) => <path key={i} d={`M${72 + i * 18} 72 c0-22 4-34 7-40 3 6 7 18 7 40z`} />)}</g>),
  MAD: () => (<g fill={INK}><path d="M60 92V66h34v26z" /><path d="M100 92V58h40v34z" /><path d="M120 58a10 10 0 0 0-20 0z" /><rect x="118" y="34" width="4" height="24" /></g>),
  LGW: () => (<g fill={INK}><rect x="70" y="44" width="16" height="48" /><path d="M78 30l9 14H69z" /><circle cx="78" cy="56" r="5" fill="#fff" opacity=".55" /><circle cx="128" cy="64" r="22" fill="none" stroke={INK} strokeWidth="3" /><path d="M128 42v44M106 64h44" stroke={INK} strokeWidth="2" /><rect x="40" y="78" width="120" height="14" /></g>),
  MAN: () => (<g fill={INK}><rect x="56" y="52" width="10" height="40" /><rect x="74" y="60" width="10" height="32" /><path d="M92 92V70h56v22z" /></g>),
  CDG: () => (<g fill="none" stroke={INK} strokeWidth="3.4"><path d="M84 92c6-22 12-36 16-52 4 16 10 30 16 52M88 74h24M92 58h16M100 40v-8" /></g>),
  AMS: () => (<g fill={INK}><path d="M52 92V62l9-10 9 10v30z" /><path d="M74 92V56l9-10 9 10v36z" /><path d="M96 92V64l9-10 9 10v28z" /><path d="M118 92V58l9-10 9 10v34z" /><rect x="44" y="86" width="112" height="6" opacity=".55" /></g>),
  BER: () => (<g fill={INK}><rect x="96" y="40" width="5" height="52" /><circle cx="98.5" cy="44" r="11" /><path d="M98.5 24l3 16h-6z" /><rect x="112" y="72" width="44" height="20" />{[0, 1, 2, 3].map((i) => <rect key={i} x={116 + i * 11} y="66" width="5" height="26" />)}</g>),
  MUC: () => (<g fill={INK}><rect x="76" y="54" width="14" height="38" /><rect x="110" y="54" width="14" height="38" /><path d="M83 54c-9-6-9-16 0-20 9 4 9 14 0 20zM117 54c-9-6-9-16 0-20 9 4 9 14 0 20z" /><rect x="90" y="70" width="20" height="22" /></g>),
  VIE: () => (<g><circle cx="86" cy="58" r="24" fill="none" stroke={INK} strokeWidth="3" />{[0, 30, 60, 90, 120, 150].map((a) => <line key={a} x1={86 - 24 * Math.cos(a * Math.PI / 180)} y1={58 - 24 * Math.sin(a * Math.PI / 180)} x2={86 + 24 * Math.cos(a * Math.PI / 180)} y2={58 + 24 * Math.sin(a * Math.PI / 180)} stroke={INK} strokeWidth="1.6" />)}<path d="M74 92l12-20 12 20z" fill={INK} /><path d="M132 92V56l8-18 8 18v36z" fill={INK} /></g>),
  PRG: () => (<g fill={INK}><path d="M40 92V78h120v14z" /><path d="M66 78V50h16v28z" /><path d="M74 34l10 16H64z" /><path d="M118 78V54h14v24z" /><path d="M125 40l8 14h-16z" /></g>),
  IST: () => (<g fill={INK}><path d="M72 92V66a28 22 0 0 1 56 0v26z" /><rect x="58" y="48" width="7" height="44" /><path d="M61.5 36l4 12h-8z" /><rect x="135" y="48" width="7" height="44" /><path d="M138.5 36l4 12h-8z" /></g>),
  LCA: () => (<g fill={INK}><rect x="96" y="56" width="5" height="36" /><path d="M98 56c-14-10-24-8-28-2 10-2 18 0 28 2zM98 56c14-10 24-8 28-2-10-2-18 0-28 2zM98 56c-6-14-2-22 4-26-2 10 0 18-4 26z" /><path d="M20 92h160" stroke={INK} strokeWidth="3" opacity=".5" /></g>),
  JTR: () => (<g><path d="M30 92h140v-6H30z" fill={INK} opacity=".35" /><g fill="#fff"><path d="M60 86V68h26v18z" /><path d="M96 86V62h30v24z" /></g><path d="M73 58a13 10 0 0 1 13 10H60a13 10 0 0 1 13-10z" fill="#1B6FA8" /><path d="M111 52a15 11 0 0 1 15 10H96a15 11 0 0 1 15-10z" fill="#1B6FA8" /></g>),
  HER: () => (<g fill={INK}><path d="M50 92V64h100v28z" />{[0, 1, 2, 3, 4, 5].map((i) => <rect key={i} x={52 + i * 17} y="56" width="10" height="10" />)}<rect x="92" y="76" width="16" height="16" fill="#fff" opacity=".2" /></g>),
  RHO: () => (<g fill={INK}>{[0, 1, 2].map((i) => (<g key={i} transform={`translate(${56 + i * 36},0)`}><path d="M0 92V58h18v34z" /><path d="M9 52l10 6H-1z" /><path d="M9 58l-16-8M9 58l16 8" stroke={INK} strokeWidth="2" /></g>))}</g>),
};
const genericCity = (seed) => (
  <g fill={INK}>{[0, 1, 2, 3, 4, 5, 6].map((i) => {
    const h = 30 + rnd(seed + i * 31) * 34;
    return <rect key={i} x={40 + i * 18} y={92 - h} width="14" height={h} />;
  })}</g>
);
function CityArt({ code }) {
  const key = ART_ALIAS[code] || code;
  const h = hash(code);
  const p = SKY[key] || [`hsl(${h % 360},42%,72%)`, `hsl(${(h % 360) + 18},44%,38%)`];
  const id = "sky" + code;
  return (
    <svg viewBox="0 0 200 110" preserveAspectRatio="xMidYMid slice" style={{ width: "100%", height: "100%", display: "block" }} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={p[0]} /><stop offset="100%" stopColor={p[1]} /></linearGradient>
        <linearGradient id={id + "s"} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#000" stopOpacity="0" /><stop offset="100%" stopColor="#000" stopOpacity=".55" /></linearGradient>
      </defs>
      <rect width="200" height="110" fill={`url(#${id})`} />
      <circle cx="166" cy="26" r="11" fill="#fff" opacity=".32" />
      {LANDMARK[key] ? LANDMARK[key]() : genericCity(h)}
      <rect y="55" width="200" height="55" fill={`url(#${id}s)`} />
    </svg>
  );
}
const CityImage = ({ code }) => (
  <div className="sky">
    {PHOTOS[code] ? <img src={PHOTOS[code]} alt={city(code)} /> : <CityArt code={code} />}
    <span className="skylabel">{city(code)}</span>
  </div>
);

/* ============================ bits ============================ */
const alColor = (c) => `hsl(${hash(c) % 360},58%,32%)`;
const Mark = ({ c }) => <div className="mark" style={{ background: alColor(c) }}>{c}</div>;

const Path = ({ o }) => (
  <div className="path">
    <div className="d">{hm(o.dur)}</div>
    <div className="pathline">{o.stops ? <i style={{ left: `${clamp((o.leg1 / o.dur) * 100, 18, 80)}%` }} /> : null}</div>
    <div className="d" style={{ color: o.stops ? "var(--navy)" : "var(--teal)", fontWeight: 600 }}>
      {o.stops ? `1 στάση${o.via && o.via !== "·" ? " · " + o.via : ""}` : "Απευθείας"}
    </div>
  </div>
);

function FareChart({ history, buckets, target, onTarget, suggested }) {
  const ref = useRef(null);
  const W = 520, H = 190, PL = 10, PR = 56, PT = 14, PB = 14;
  const lo = Math.min(...buckets), hi = Math.max(...buckets);
  const y = (p) => PT + (1 - (p - lo) / (hi - lo || 1)) * (H - PT - PB);
  const x = (i) => PL + (i / (history.length - 1)) * (W - PL - PR);
  let d = `M${x(0)},${y(history[0])}`;
  for (let i = 1; i < history.length; i++) d += ` L${x(i)},${y(history[i - 1])} L${x(i)},${y(history[i])}`;
  const snap = useCallback((cy) => {
    const r = ref.current.getBoundingClientRect();
    const py = ((cy - r.top) / r.height) * H;
    const price = lo + (1 - (py - PT) / (H - PT - PB)) * (hi - lo);
    const allow = buckets.filter((b) => b < history[history.length - 1]);
    if (!allow.length) return;
    onTarget(allow.reduce((a, b) => (Math.abs(b - price) < Math.abs(a - price) ? b : a)));
  }, [buckets, history, lo, hi, onTarget]);
  const start = (e) => {
    if (!onTarget) return;
    e.preventDefault();
    snap(e.touches ? e.touches[0].clientY : e.clientY);
    const mv = (ev) => snap(ev.touches ? ev.touches[0].clientY : ev.clientY);
    const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); window.removeEventListener("touchmove", mv); window.removeEventListener("touchend", up); };
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
    window.addEventListener("touchmove", mv, { passive: false }); window.addEventListener("touchend", up);
  };
  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block", touchAction: "none", cursor: onTarget ? "ns-resize" : "default" }} onMouseDown={start} onTouchStart={start}>
      {buckets.map((b) => (<g key={b}><line x1={PL} x2={W - PR} y1={y(b)} y2={y(b)} stroke="#E7EAEE" /><text x={W - PR + 7} y={y(b) + 3.5} fontSize="10" fill="#626971">{eur(b)}</text></g>))}
      {target != null && <rect x={PL} y={y(target)} width={W - PL - PR} height={Math.max(0, H - PB - y(target))} fill="#E8590C" opacity=".06" />}
      <path d={d} fill="none" stroke="#05203C" strokeWidth="2" />
      <circle cx={x(history.length - 1)} cy={y(history[history.length - 1])} r="4" fill="#05203C" />
      {suggested != null && suggested !== target && (<g><line x1={PL} x2={W - PR} y1={y(suggested)} y2={y(suggested)} stroke="#626971" strokeDasharray="3 4" /><text x={PL + 4} y={y(suggested) - 5} fontSize="10" fill="#626971">πρόταση {eur(suggested)}</text></g>)}
      {target != null && (<>
        <line x1={PL} x2={W - PR} y1={y(target)} y2={y(target)} stroke="#E8590C" strokeWidth="2" strokeDasharray="7 4" />
        <g transform={`translate(${PL + 2},${y(target)})`}><rect x="0" y="-11" width="96" height="22" rx="5" fill="#E8590C" /><text x="10" y="4.5" fontSize="12" fontWeight="700" fill="#fff">{onTarget ? "⇕ " : ""}limit {eur(target)}</text></g>
      </>)}
    </svg>
  );
}

/* ============================ app ============================ */
export default function SkyTrade() {
  const [tick, setTick] = useState(30);
  const [page, setPage] = useState("home");
  const [origin, setOrigin] = useState("ATH");
  const [dest, setDest] = useState("FCO");
  const [date, setDate] = useState(() => addDays(26));
  const [adults, setAdults] = useState(1);
  const [trip, setTrip] = useState("oneway");
  const [sort, setSort] = useState("best");
  const [filters, setFilters] = useState({ direct: false, carriers: [], maxPrice: 1e6, dep: 0 });
  const [showFilters, setShowFilters] = useState(false);
  const [picker, setPicker] = useState("to");
  const [query, setQuery] = useState("");
  const [calMonth, setCalMonth] = useState(() => new Date(TODAY.getFullYear(), TODAY.getMonth(), 1));
  const [sel, setSel] = useState(null);
  const [target, setTarget] = useState(null);
  const [watchDays, setWatchDays] = useState(14);
  const [pax, setPax] = useState({ name: "IGLI KOTSIAI", dob: "1999-04-12", doc: "AM4471209", email: "igli@example.com" });
  const [orders, setOrders] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 2200); return () => clearInterval(t); }, []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 3400); return () => clearTimeout(t); }, [toast]);
  useEffect(() => { setFilters((f) => ({ ...f, carriers: [], maxPrice: 1e6 })); }, [origin, dest, date]);

  // Live mode: real offers from the backend, refreshed every 30 s. Falls back to simulation on error.
  const [liveOffers, setLiveOffers] = useState(null);
  const [liveState, setLiveState] = useState(API ? "loading" : "off");
  const [liveTick, setLiveTick] = useState(0);
  useEffect(() => { if (!API) return; const t = setInterval(() => setLiveTick((x) => x + 1), 30000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (!API || origin === dest) return;
    let dead = false;
    const day = ymd(date);
    setLiveState("loading");
    Promise.all([api.search(origin, dest, day, 1), api.history(origin, dest, day).catch(() => ({ points: [] }))])
      .then(([s, h]) => {
        if (dead) return;
        const hist = h.points.map((p) => p.price);
        setLiveOffers(s.offers.map((o) => toResult(o, hist)));
        setLiveState("ok");
      })
      .catch(() => { if (!dead) { setLiveOffers(null); setLiveState("error"); } });
    return () => { dead = true; };
  }, [origin, dest, date, liveTick]);
  const simulated = useMemo(() => buildResults(origin, dest, date, tick), [origin, dest, date, tick]);
  const all = liveState === "ok" && liveOffers ? liveOffers : simulated;
  const cheapest = useMemo(() => (all.length ? all.reduce((a, b) => (b.price < a.price ? b : a)) : null), [all]);
  const fastest = useMemo(() => (all.length ? all.reduce((a, b) => (b.dur < a.dur ? b : a)) : null), [all]);
  const score = (o) => o.price + (o.dur - (fastest?.dur || 0)) * 0.3 + o.stops * 30;
  const bestOne = useMemo(() => (all.length ? all.reduce((a, b) => (score(b) < score(a) ? b : a)) : null), [all]);
  const look = useMemo(() => (cheapest ? outlook(cheapest.history, cheapest.price) : null), [cheapest]);
  const usedCarriers = useMemo(() => [...new Set(all.map((o) => o.carrier))], [all]);
  const nonstopExists = ROUTESET[origin]?.has(dest);

  const shown = useMemo(() => {
    const l = all.filter((o) => (filters.direct ? o.stops === 0 : true))
      .filter((o) => (filters.carriers.length ? filters.carriers.includes(o.carrier) : true))
      .filter((o) => o.price <= filters.maxPrice)
      .filter((o) => o.depM / 60 >= filters.dep);
    return l.sort((a, b) => (sort === "cheap" ? a.price - b.price : sort === "fast" ? a.dur - b.dur : score(a) - score(b)));
  }, [all, filters, sort]);

  /* nonstop destinations from this origin, at their cheapest day */
  const destinations = useMemo(() => {
    const list = ROUTES[origin] || [];
    return list.map((d) => {
      let bp = Infinity, bd = null;
      for (let i = 6; i < 48; i += 2) { const day = addDays(i), p = dayPrice(origin, d, day); if (p < bp) { bp = p; bd = day; } }
      return { code: d, city: city(d), country: AIRPORTS[d]?.country || "", price: bp, date: bd, km: Math.round(km(origin, d)) };
    }).sort((a, b) => a.price - b.price);
  }, [origin]);

  const airportSearch = useMemo(() => {
    const q = norm(query);
    if (!q) return null;
    return CODES.filter((c) => {
      const a = AIRPORTS[c];
      return norm(c).includes(q) || norm(a.city).includes(q) || norm(a.country).includes(q) || norm(a.enCity).includes(q) || norm(a.enCountry).includes(q);
    }).sort((a, b) => (ROUTES[b]?.length || 0) - (ROUTES[a]?.length || 0)).slice(0, 40);
  }, [query]);

  // live calendar prices from the backend (days it has no fare for keep the simulated price)
  const [liveCal, setLiveCal] = useState({});
  useEffect(() => {
    if (!API || page !== "calendar" || origin === dest) return;
    let dead = false;
    const first = new Date(calMonth.getFullYear(), calMonth.getMonth(), 1);
    const start = first > TODAY ? first : addDays(1);
    const days = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 0).getDate() - (start.getDate() - 1);
    if (days < 1) return;
    api.calendar(origin, dest, ymd(start), days)
      .then((r) => { if (!dead) setLiveCal(Object.fromEntries(r.days.map((d) => [d.date, d.price]))); })
      .catch(() => { if (!dead) setLiveCal({}); });
    return () => { dead = true; };
  }, [calMonth, origin, dest, page]);

  const calGrid = useMemo(() => {
    const first = new Date(calMonth.getFullYear(), calMonth.getMonth(), 1);
    const n = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 0).getDate();
    const cells = Array.from({ length: (first.getDay() + 6) % 7 }, () => null);
    for (let i = 1; i <= n; i++) {
      const d = new Date(calMonth.getFullYear(), calMonth.getMonth(), i);
      const past = d <= TODAY;
      cells.push({ d, price: past ? null : (API && liveCal[ymd(d)]) || dayPrice(origin, dest, d), past });
    }
    const ps = cells.filter((c) => c && c.price).map((c) => c.price);
    return { cells, min: ps.length ? Math.min(...ps) : 0 };
  }, [calMonth, origin, dest, liveCal]);

  useEffect(() => {
    setOrders((os) => os.map((o) => {
      if (o.status !== "watching" || o.serverId) return o;
      const pool = buildResults(o.origin, o.dest, new Date(o.dateISO), tick);
      const cand = (o.anyFlight ? pool : pool.filter((x) => x.id === o.offerId)).sort((a, b) => a.price - b.price)[0];
      if (cand && cand.price <= o.target) {
        setToast(`Η εντολή εκτελέστηκε — ${o.origin}→${o.dest} στα ${eur(cand.price)}`);
        return { ...o, status: "filled", filledPrice: cand.price, filledOffer: cand, ref: "SKY" + Math.random().toString(36).slice(2, 7).toUpperCase() };
      }
      return { ...o, now: cand ? cand.price : o.now };
    }));
  }, [tick]);

  useEffect(() => {
    if (!API) return;
    const t = setInterval(() => {
      api.listOrders(pax.email).then((list) => {
        setOrders((os) => os.map((o) => {
          const r = o.serverId && list.find((x) => x.id === o.serverId);
          if (!r || (r.status === o.status && r.filled_price === o.filledPrice)) return o;
          if (r.status === "filled") setToast(`Η εντολή εκτελέστηκε — ${o.origin}→${o.dest} στα ${eur(r.filled_price)}`);
          return { ...o, status: r.status, filledPrice: r.filled_price, ref: r.booking_ref, filledOffer: o.filledOffer || o };
        }));
      }).catch(() => {});
    }, 15000);
    return () => clearInterval(t);
  }, [pax.email]);

  const watching = orders.filter((o) => o.status === "watching").length;
  const open = orders.find((o) => o.id === openId);

  const goLimit = (offer, anyFlight = false) => {
    const src = offer || cheapest;
    if (!src) return;
    setSel({ ...src, anyFlight });
    const below = src.buckets.filter((b) => b < src.price);
    setTarget(anyFlight ? look.suggested : below.length ? below[below.length - 1] : src.price);
    setPage("limit");
  };
  const place = () => {
    if (API) {
      api.createOrder({ user_email: pax.email, origin, destination: dest, depart_date: ymd(date), limit_price: target, watch_days: watchDays, max_stops: sel.stops || 0 })
        .then((r) => {
          setOrders((os) => [{ id: "s" + r.id, serverId: r.id, origin, dest, dateISO: ymd(date), offerId: sel.id, carrier: sel.carrier, airline: sel.airline, code: sel.code, anyFlight: sel.anyFlight, target, entry: r.entry_price ?? sel.price, now: r.entry_price ?? sel.price, watchDays, status: r.status, filledPrice: r.filled_price, ref: r.booking_ref, filledOffer: sel, pax: { ...pax } }, ...os]);
          setToast(r.status === "filled" ? `Η εντολή εκτελέστηκε στα ${eur(r.filled_price)}` : `Εντολή ενεργή στο backend · θα αγοραστεί στα ${eur(target)}`);
          setPage("orders");
        })
        .catch((e) => setToast("Η εντολή δεν δημιουργήθηκε: " + e.message));
      return;
    }
    setOrders((os) => [{ id: Date.now(), origin, dest, dateISO: ymd(date), offerId: sel.id, carrier: sel.carrier, airline: sel.airline, code: sel.code, anyFlight: sel.anyFlight, target, entry: sel.price, now: sel.price, watchDays, status: "watching", pax: { ...pax } }, ...os]);
    setToast(`Εντολή ενεργή · θα αγοραστεί στα ${eur(target)}`);
    setPage("orders");
  };
  const buyNow = (o) => {
    setOrders((os) => [{ id: Date.now(), origin, dest, dateISO: ymd(date), offerId: o.id, carrier: o.carrier, airline: o.airline, code: o.code, target: o.price, entry: o.price, status: "filled", instant: true, filledPrice: o.price, filledOffer: o, ref: "SKY" + Math.random().toString(36).slice(2, 7).toUpperCase(), pax: { ...pax } }, ...os]);
    setToast(`Κρατήθηκε ${origin}→${dest} στα ${eur(o.price)}`);
    setPage("orders");
  };
  const dLong = (d) => d.toLocaleDateString("el-GR", { weekday: "short", day: "numeric", month: "short" });
  const carrierLow = (c) => Math.min(...all.filter((o) => o.carrier === c).map((o) => o.price));

  const AirportRow = ({ code, onPick, price }) => {
    const a = AIRPORTS[code];
    return (
      <button className="aprow" onClick={() => onPick(code)}>
        <b style={{ width: 44 }}>{code}</b>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{a.city}</div>
          <div className="muted" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {a.country}{ROUTES[code] ? ` · ${ROUTES[code].length} απευθείας προορισμοί` : ""}
          </div>
        </div>
        {price != null && <div className="muted">από <b style={{ color: "var(--navy)" }}>{eur(price)}</b></div>}
      </button>
    );
  };

  return (
    <div className="st">
      <style>{CSS}</style>

      <div className="hdr">
        <div className="wrap hdr-in">
          <div className="logo" onClick={() => setPage("home")}>sky<span>trade</span></div>
          <div className="nav desk-only">
            <button className={["home", "results", "limit", "checkout", "calendar", "picker"].includes(page) ? "on" : ""} onClick={() => setPage("home")}>Πτήσεις</button>
            <button className={page === "orders" || page === "ticket" ? "on" : ""} onClick={() => setPage("orders")}>Οι εντολές μου{watching ? ` (${watching})` : ""}</button>
            <button className={page === "explore" ? "on" : ""} onClick={() => setPage("explore")}>Εξερεύνηση</button>
          </div>
          <div className="pill"><span className="desk-only">EUR €</span><div className="avatar">ΙΚ</div></div>
        </div>
      </div>

      {/* ---------- HOME ---------- */}
      {page === "home" && (
        <>
          <div className="hero">
            <div className="wrap">
              <h1>Βρες την πτήση. Όρισε την τιμή.<br />Εμείς την αγοράζουμε όταν πέσει.</h1>
              <p>{CODES.length.toLocaleString("el-GR")} αεροδρόμια, πραγματικές απευθείας συνδέσεις και αεροπορικές.</p>
            </div>
          </div>
          <div className="wrap">
            <div className="panel">
              <div className="tabs">
                {[["oneway", "Απλή μετάβαση"], ["return", "Με επιστροφή"]].map(([k, l]) => (
                  <button key={k} className={"tab" + (trip === k ? " on" : "")} onClick={() => setTrip(k)}>{l}</button>
                ))}
              </div>
              <div className="fields">
                <button className="field" onClick={() => { setPicker("from"); setQuery(""); setPage("picker"); }}>
                  <label>Από</label>
                  <div className="val">{city(origin)} ({origin})</div>
                  <div className="sub">{AIRPORTS[origin]?.country} · {(ROUTES[origin] || []).length} προορισμοί</div>
                </button>
                <button className="field" onClick={() => { setPicker("to"); setQuery(""); setPage("picker"); }}>
                  <label>Προς</label>
                  <div className="val">{city(dest)} ({dest})</div>
                  <div className="sub">{AIRPORTS[dest]?.country} · {Math.round(km(origin, dest))} χλμ</div>
                </button>
                <button className="field" onClick={() => { setCalMonth(new Date(date.getFullYear(), date.getMonth(), 1)); setPage("calendar"); }}>
                  <label>Αναχώρηση</label>
                  <div className="val">{dLong(date)}</div>
                  <div className="sub">δες τιμές ανά ημέρα</div>
                </button>
                <div className="field" style={{ cursor: "default" }}>
                  <label>Ταξιδιώτες</label>
                  <div className="val" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <button className="link" onClick={() => setAdults((a) => Math.max(1, a - 1))}>−</button>{adults}
                    <button className="link" onClick={() => setAdults((a) => Math.min(6, a + 1))}>+</button>
                  </div>
                  <div className="sub">ενήλικες, οικονομική</div>
                </div>
                <button className="go" onClick={() => setPage("results")}>Αναζήτηση</button>
              </div>
            </div>

            <h2 className="sec-h">Απευθείας από {city(origin)}</h2>
            <p className="sec-p">{destinations.length} προορισμοί χωρίς στάση · η φθηνότερη ημέρα κάθε προορισμού μέσα στις επόμενες έξι εβδομάδες.</p>
            <div className="tiles">
              {destinations.slice(0, 12).map((d, i) => (
                <button key={d.code} className="tile" onClick={() => { setDest(d.code); setDate(d.date); setPage("results"); }}>
                  <CityImage code={d.code} />
                  <div className="body">
                    <div className="row"><span className="muted">{d.country}</span><span className="price">{eur(d.price)}</span></div>
                    <div className="muted" style={{ marginTop: 4 }}>{d.date.toLocaleDateString("el-GR", { day: "numeric", month: "short" })} · {d.km} χλμ</div>
                    {i === 0 && <div className="tag tag-green" style={{ marginTop: 8 }}>Φθηνότερο τώρα</div>}
                  </div>
                </button>
              ))}
            </div>
            {destinations.length > 12 && <button className="link" style={{ marginTop: 14 }} onClick={() => setPage("explore")}>Δες και τους {destinations.length - 12} υπόλοιπους →</button>}
            <div style={{ height: 40 }} />
          </div>
        </>
      )}

      {/* ---------- PICKER ---------- */}
      {page === "picker" && (
        <div className="wrap" style={{ paddingTop: 20, paddingBottom: 60, maxWidth: 700 }}>
          <button className="link" onClick={() => setPage("home")}>← Πίσω</button>
          <h2 className="sec-h" style={{ marginTop: 10 }}>{picker === "from" ? "Από πού φεύγεις;" : `Πού θες να πας από ${city(origin)};`}</h2>
          <input autoFocus className="inp" placeholder="Πόλη, χώρα ή κωδικός (π.χ. Τίρανα, Tirana, Ιταλία, JFK)" value={query} onChange={(e) => setQuery(e.target.value)} />

          {airportSearch ? (
            <div style={{ marginTop: 14 }}>
              <p className="sec-p">{airportSearch.length} αεροδρόμια</p>
              {airportSearch.map((c) => (
                <AirportRow key={c} code={c} onPick={(x) => { picker === "from" ? setOrigin(x) : setDest(x); setPage("home"); }}
                  price={picker === "to" && c !== origin ? dayPrice(origin, c, addDays(26)) : null} />
              ))}
              {airportSearch.length === 0 && <div className="card">Δεν βρέθηκε αεροδρόμιο. Δοκίμασε άλλη λέξη ή τον κωδικό IATA.</div>}
            </div>
          ) : picker === "from" ? (
            <div style={{ marginTop: 14 }}>
              <p className="sec-p">Ελλάδα και Κύπρος</p>
              {CODES.filter((c) => ["Ελλάδα", "Κύπρος"].includes(AIRPORTS[c].country))
                .sort((a, b) => (ROUTES[b]?.length || 0) - (ROUTES[a]?.length || 0))
                .map((c) => <AirportRow key={c} code={c} onPick={(x) => { setOrigin(x); setPage("home"); }} />)}
            </div>
          ) : (
            <div style={{ marginTop: 14 }}>
              <p className="sec-p">Απευθείας από {city(origin)} — φθηνότερα πρώτα</p>
              {destinations.map((d) => <AirportRow key={d.code} code={d.code} price={d.price} onPick={(x) => { setDest(x); setPage("home"); }} />)}
              {destinations.length === 0 && <div className="card">Από αυτό το αεροδρόμιο δεν υπάρχουν απευθείας πτήσεις στα δεδομένα. Γράψε προορισμό και θα βρούμε διαδρομή με στάση.</div>}
            </div>
          )}
        </div>
      )}

      {/* ---------- CALENDAR ---------- */}
      {page === "calendar" && (
        <div className="wrap" style={{ paddingTop: 20, paddingBottom: 60, maxWidth: 560 }}>
          <button className="link" onClick={() => setPage("home")}>← Πίσω</button>
          <div className="card" style={{ marginTop: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <button className="link" onClick={() => setCalMonth(new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1))}>‹ Προηγ.</button>
              <b>{calMonth.toLocaleDateString("el-GR", { month: "long", year: "numeric" })}</b>
              <button className="link" onClick={() => setCalMonth(new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1))}>Επόμ. ›</button>
            </div>
            <div className="cal">
              {["Δε", "Τρ", "Τε", "Πε", "Πα", "Σα", "Κυ"].map((d, i) => <div key={i} className="muted" style={{ textAlign: "center", fontWeight: 700, paddingBottom: 6 }}>{d}</div>)}
              {calGrid.cells.map((c, i) => c ? (
                <button key={i} disabled={c.past} className={ymd(c.d) === ymd(date) ? "sel" : c.price === calGrid.min ? "cheap" : ""} onClick={() => { setDate(c.d); setPage("results"); }}>
                  <div className="n">{c.d.getDate()}</div><div className="p">{c.price ? eur(c.price) : "—"}</div>
                </button>
              ) : <div key={i} />)}
            </div>
            <p className="sec-p" style={{ marginTop: 14, marginBottom: 0 }}>Με πράσινο η φθηνότερη ημέρα ({eur(calGrid.min)}) για {origin} → {dest}.</p>
          </div>
        </div>
      )}

      {/* ---------- RESULTS ---------- */}
      {page === "results" && !cheapest && (
        <div className="wrap" style={{ paddingTop: 24 }}>
          <div className="card"><b>Δεν βρέθηκε διαδρομή {origin} → {dest}.</b>
          <p className="sec-p" style={{ margin: "4px 0 10px" }}>Τα δεδομένα δεν δείχνουν σύνδεση ανάμεσα σε αυτά τα δύο αεροδρόμια, ούτε με στάση. Δοκίμασε μεγαλύτερο αεροδρόμιο κοντά σου ή άλλον προορισμό.</p>
          <button className="btn btn-blue" style={{ width: "auto" }} onClick={() => setPage("home")}>Νέα αναζήτηση</button></div>
        </div>
      )}

      {page === "results" && cheapest && (
        <>
          <div className="bar">
            <div className="wrap bar-in">
              <h2>{city(origin)} → {city(dest)}</h2>
              <span className="muted">{dLong(date)} · {adults} ενήλικ{adults > 1 ? "ες" : "ας"} · {Math.round(km(origin, dest))} χλμ</span>
              <button className="link" onClick={() => setPage("home")}>Αλλαγή αναζήτησης</button>
              <button className="link mobile-only" style={{ marginLeft: "auto" }} onClick={() => setShowFilters((v) => !v)}>{showFilters ? "Κλείσιμο φίλτρων" : "Φίλτρα"}</button>
            </div>
          </div>

          <div className="wrap">
            {!nonstopExists && (
              <div className="card" style={{ marginTop: 16, borderLeft: "4px solid var(--blue)" }}>
                <b>Δεν υπάρχει απευθείας πτήση {origin} → {dest}.</b>
                <p className="sec-p" style={{ margin: "4px 0 0" }}>Σου δείχνουμε διαδρομές με μία στάση, μέσα από κόμβους που συνδέονται πραγματικά και με τα δύο αεροδρόμια.</p>
              </div>
            )}

            <div className="sorts">
              {[["best", "Καλύτερη", bestOne], ["cheap", "Φθηνότερη", cheapest], ["fast", "Γρηγορότερη", fastest]].map(([k, l, o]) => (
                <button key={k} className={"sort" + (sort === k ? " on" : "")} onClick={() => setSort(k)}>
                  <b>{l} · {eur(o.price)}</b><span>{hm(o.dur)} · {o.stops ? "1 στάση" : "απευθείας"}</span>
                </button>
              ))}
            </div>

            <div className="cols">
              <div className="filters" style={{ display: showFilters ? "block" : undefined }}>
                <div className="fgroup">
                  <h4>Στάσεις</h4>
                  <label className="chk"><input type="checkbox" disabled={!nonstopExists} checked={filters.direct} onChange={(e) => setFilters({ ...filters, direct: e.target.checked })} /> Μόνο απευθείας
                    <span className="r">{nonstopExists ? eur(Math.min(...all.filter((o) => !o.stops).map((o) => o.price))) : "—"}</span></label>
                </div>
                <div className="fgroup">
                  <h4>Αεροπορικές</h4>
                  {usedCarriers.map((c) => (
                    <label key={c} className="chk">
                      <input type="checkbox" checked={filters.carriers.includes(c)}
                        onChange={(e) => setFilters({ ...filters, carriers: e.target.checked ? [...filters.carriers, c] : filters.carriers.filter((x) => x !== c) })} />
                      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 110 }}>{AIRLINE[c] || c}</span>
                      <span className="r">{eur(carrierLow(c))}</span>
                    </label>
                  ))}
                </div>
                <div className="fgroup">
                  <h4>Μέγιστη τιμή</h4>
                  <input type="range" min={Math.min(...all.map((o) => o.price))} max={Math.max(...all.map((o) => o.price))}
                    value={Math.min(filters.maxPrice, Math.max(...all.map((o) => o.price)))}
                    onChange={(e) => setFilters({ ...filters, maxPrice: Number(e.target.value) })} />
                  <div className="muted" style={{ marginTop: 6 }}>έως {eur(Math.min(filters.maxPrice, Math.max(...all.map((o) => o.price))))}</div>
                </div>
                <div className="fgroup">
                  <h4>Αναχώρηση μετά τις</h4>
                  <input type="range" min={0} max={20} value={filters.dep} onChange={(e) => setFilters({ ...filters, dep: Number(e.target.value) })} />
                  <div className="muted" style={{ marginTop: 6 }}>{String(filters.dep).padStart(2, "0")}:00</div>
                </div>
                <button className="btn btn-line" onClick={() => setFilters({ direct: false, carriers: [], maxPrice: 1e6, dep: 0 })}>Καθαρισμός φίλτρων</button>
              </div>

              <div>
                <div className="card" style={{ borderLeft: `4px solid ${look.dir === "rising" ? "#C0341D" : look.dir === "falling" ? "var(--teal)" : "var(--grey)"}` }}>
                  <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <div style={{ flex: 1, minWidth: 230 }}>
                      <h3 className="h3">{look.dir === "rising" ? "Η τιμή ανεβαίνει" : look.dir === "falling" ? "Η τιμή πέφτει" : "Η τιμή είναι σταθερή"}
                        <span className="muted" style={{ fontWeight: 500, marginLeft: 8 }}>{look.conf}% σιγουριά</span></h3>
                      <p className="sec-p" style={{ margin: "4px 0 0" }}>{look.msg}</p>
                    </div>
                    <div style={{ display: "flex", gap: 10 }}>
                      <div className="kv"><label>Προτεινόμενο limit</label><div style={{ color: "var(--orange)" }}>{eur(look.suggested)}</div></div>
                      <div className="kv"><label>Χαμηλό περιόδου</label><div>{eur(look.low)}</div></div>
                    </div>
                    <button className="btn btn-orange" style={{ width: "auto", alignSelf: "center" }} onClick={() => goLimit(cheapest, true)}>Παρακολούθηση διαδρομής</button>
                  </div>
                </div>

                <p className="sec-p" style={{ margin: "0 0 10px" }}>{shown.length} αποτελέσματα · τιμές ανά άτομο με φόρους · {liveState === "ok" ? "ζωντανές τιμές από το API" : liveState === "loading" ? "φόρτωση τιμών…" : liveState === "error" ? "το API δεν απαντά, δείχνω προσομοίωση" : "προσομοιωμένες τιμές"}</p>

                {shown.map((o) => (
                  <div className="res" key={o.id}>
                    <div className="res-in">
                      <div className="leg">
                        <Mark c={o.carrier} />
                        <div className="times">
                          <div className="t">{clock(o.depM)}<small>{origin}</small></div>
                          <Path o={o} />
                          <div className="t">{clock(o.arrM)}<small>{dest}</small></div>
                        </div>
                        <div className="desk-only" style={{ width: 124, fontSize: 12, color: "var(--grey)" }}>
                          {o.airline}<br />{o.code}<br />
                          <span style={{ fontSize: 11 }}>{o.lowcost ? "1 μικρή τσάντα" : "χειραποσκευή + βαλίτσα"}</span>
                        </div>
                      </div>
                      <div className="buy">
                        <div>
                          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.5px" }}>{eur(o.price)}</div>
                          <div className="muted">
                            {o.id === cheapest.id ? <span className="tag tag-green">Φθηνότερη</span>
                              : o.seatsLeft < 4 ? <span className="tag tag-red">{o.seatsLeft} θέσεις</span>
                                : o.stops ? <span className="tag tag-grey">{o.layover ? hm(o.layover) + " στάση" : "με στάση"}</span> : "σύνολο"}
                          </div>
                        </div>
                        <button className="btn btn-blue" onClick={() => buyNow(o)}>Κράτηση</button>
                      </div>
                    </div>
                    <div className="limitbar">
                      <span>Δεν βιάζεσαι; Βάλε limit στα <b>{eur(r5(o.price * 0.88))}</b> και το αγοράζουμε μόνοι μας αν πέσει.</span>
                      <button className="link" style={{ color: "var(--orange)", marginLeft: "auto" }} onClick={() => goLimit(o)}>Ρύθμιση →</button>
                    </div>
                  </div>
                ))}
                {shown.length === 0 && <div className="card">Κανένα αποτέλεσμα με αυτά τα φίλτρα.</div>}
              </div>
            </div>
          </div>
        </>
      )}

      {/* ---------- LIMIT ---------- */}
      {page === "limit" && sel && (
        <div className="wrap" style={{ paddingTop: 20, paddingBottom: 60, maxWidth: 760 }}>
          <button className="link" onClick={() => setPage("results")}>← Πίσω στα αποτελέσματα</button>
          <div className="card" style={{ marginTop: 10 }}>
            <h3 className="h3">{city(origin)} → {city(dest)}</h3>
            <p className="sec-p">{sel.anyFlight ? "Όλες οι πτήσεις της ημέρας" : `${sel.airline} ${sel.code} · ${clock(sel.depM)}–${clock(sel.arrM)}${sel.stops ? ` · στάση ${sel.via}` : ""}`} · {dLong(date)}</p>
            <p className="sec-p" style={{ marginBottom: 10 }}>Σύρε την πορτοκαλί γραμμή στην τιμή που θα πλήρωνες ευχαρίστως. Οι ναύλοι υπάρχουν μόνο στα σκαλοπάτια δεξιά, οπότε η γραμμή κουμπώνει σε αυτά.</p>
            <FareChart history={sel.history} buckets={sel.buckets} target={target} onTarget={setTarget} suggested={look?.suggested} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 10, marginTop: 16 }}>
              <div className="kv"><label>Τιμή τώρα</label><div>{eur(sel.price)}</div></div>
              <div className="kv"><label>Το limit σου</label><div style={{ color: "var(--orange)" }}>{eur(target)}</div></div>
              <div className="kv"><label>Γλιτώνεις</label><div style={{ color: "var(--teal)" }}>{eur(sel.price - target)}</div></div>
              <div className="kv"><label>Πιθανότητα</label><div>{clamp(Math.round(92 - ((sel.price - target) / sel.price) * 340), 5, 90)}%</div></div>
            </div>
            <h4 style={{ margin: "18px 0 8px", fontSize: 13 }}>Παρακολούθηση για</h4>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[7, 14, 30].map((d) => <button key={d} className={"tab" + (watchDays === d ? " on" : "")} onClick={() => setWatchDays(d)}>{d} ημέρες</button>)}
            </div>
            <button className="btn btn-orange" style={{ marginTop: 18 }} onClick={() => setPage("checkout")}>Συνέχεια στα στοιχεία</button>
          </div>
        </div>
      )}

      {/* ---------- CHECKOUT ---------- */}
      {page === "checkout" && sel && (
        <div className="wrap" style={{ paddingTop: 20, paddingBottom: 60, maxWidth: 760 }}>
          <button className="link" onClick={() => setPage("limit")}>← Πίσω</button>
          <div className="card" style={{ marginTop: 10 }}>
            <h3 className="h3">Στοιχεία επιβάτη</h3>
            <p className="sec-p">Χρειάζονται τώρα, ώστε να εκδοθεί το εισιτήριο την ίδια στιγμή που πέφτει η τιμή.</p>
            <label className="lbl">Ονοματεπώνυμο (όπως στο διαβατήριο)</label>
            <input className="inp" value={pax.name} onChange={(e) => setPax({ ...pax, name: e.target.value })} />
            <div className="grid2" style={{ marginTop: 12 }}>
              <div><label className="lbl">Ημερομηνία γέννησης</label><input className="inp" value={pax.dob} onChange={(e) => setPax({ ...pax, dob: e.target.value })} /></div>
              <div><label className="lbl">Αριθμός διαβατηρίου</label><input className="inp" value={pax.doc} onChange={(e) => setPax({ ...pax, doc: e.target.value })} /></div>
            </div>
            <div style={{ marginTop: 12 }}><label className="lbl">Email</label><input className="inp" value={pax.email} onChange={(e) => setPax({ ...pax, email: e.target.value })} /></div>
            <h3 className="h3" style={{ marginTop: 22 }}>Πληρωμή</h3>
            <div className="kv" style={{ display: "flex", alignItems: "center", gap: 12 }}><b>VISA</b><span>•••• •••• •••• 4921</span><button className="link" style={{ marginLeft: "auto" }}>Αλλαγή</button></div>
            <div style={{ background: "var(--orange-s)", border: "1px solid #F7C9A8", borderRadius: 10, padding: 13, marginTop: 12, fontSize: 13.5, lineHeight: 1.55 }}>
              Η κάρτα χρεώνεται <b>μόνο αν η τιμή πιάσει τα {eur(target)}</b>. Μέχρι τότε δεν δεσμεύεται κανένα ποσό και ακυρώνεις ελεύθερα.
            </div>
            <button className="btn btn-orange" style={{ marginTop: 16 }} onClick={place}>Τοποθέτηση εντολής στα {eur(target)}</button>
          </div>
        </div>
      )}

      {/* ---------- ORDERS ---------- */}
      {page === "orders" && (
        <div className="wrap" style={{ paddingTop: 22, paddingBottom: 60, maxWidth: 860 }}>
          <h2 className="sec-h" style={{ marginTop: 0 }}>Οι εντολές μου</h2>
          <p className="sec-p">Οι ενεργές εντολές ελέγχονται αυτόματα κάθε λίγα λεπτά.</p>
          {orders.length === 0 && <div className="card">Δεν έχεις εντολές ακόμα. <button className="link" onClick={() => setPage("home")}>Ψάξε μια πτήση</button> και βάλε την τιμή που θέλεις.</div>}
          {orders.map((o) => {
            const filled = o.status === "filled";
            const prog = filled ? 100 : clamp(((o.entry - (o.now || o.entry)) / ((o.entry - o.target) || 1)) * 100, 3, 97);
            return (
              <div className="card" key={o.id}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <Mark c={o.carrier} />
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <b style={{ fontSize: 15 }}>{city(o.origin)} → {city(o.dest)}</b>
                    <div className="muted">{o.anyFlight && !filled ? "όποια πτήση της ημέρας" : `${o.airline} ${o.code}`} · {new Date(o.dateISO).toLocaleDateString("el-GR", { day: "numeric", month: "short" })}</div>
                  </div>
                  <span className="tag" style={{ background: filled ? "#E3F6F4" : "var(--orange-s)", color: filled ? "var(--teal)" : "var(--orange)" }}>
                    {filled ? (o.instant ? "ΚΡΑΤΗΘΗΚΕ" : "ΕΚΤΕΛΕΣΤΗΚΕ") : "ΕΝΕΡΓΗ"}
                  </span>
                  {filled
                    ? <button className="btn btn-blue" style={{ width: "auto" }} onClick={() => { setOpenId(o.id); setPage("ticket"); }}>Εισιτήριο</button>
                    : <button className="btn btn-line" style={{ width: "auto" }} onClick={() => { const done = () => { setOrders((os) => os.filter((x) => x.id !== o.id)); setToast("Η εντολή ακυρώθηκε. Δεν χρεώθηκε τίποτα."); }; if (o.serverId) api.cancelOrder(o.serverId).then(done).catch((e) => setToast("Αποτυχία ακύρωσης: " + e.message)); else done(); }}>Ακύρωση</button>}
                </div>
                {!filled && (<>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginTop: 14 }}>
                    <span className="muted">τώρα <b style={{ color: "var(--navy)" }}>{eur(o.now || o.entry)}</b></span>
                    <span className="muted">limit <b style={{ color: "var(--orange)" }}>{eur(o.target)}</b></span>
                  </div>
                  <div style={{ height: 6, background: "#EDF0F3", borderRadius: 4, marginTop: 7, overflow: "hidden" }}>
                    <div style={{ width: prog + "%", height: "100%", background: "var(--orange)", transition: "width .6s ease" }} />
                  </div>
                  <div className="muted" style={{ marginTop: 7 }}>Απέχει {eur(Math.max(0, (o.now || o.entry) - o.target))} · λήγει σε {o.watchDays} ημέρες</div>
                </>)}
                {filled && <div className="muted" style={{ marginTop: 10 }}>Κωδικός {o.ref} · πληρώθηκαν {eur(o.filledPrice)}{!o.instant && o.entry > o.filledPrice && ` · γλίτωσες ${eur(o.entry - o.filledPrice)}`}</div>}
              </div>
            );
          })}
        </div>
      )}

      {/* ---------- TICKET ---------- */}
      {page === "ticket" && open && open.filledOffer && (
        <div className="wrap" style={{ paddingTop: 22, paddingBottom: 60, maxWidth: 620 }}>
          <button className="link" onClick={() => setPage("orders")}>← Οι εντολές μου</button>
          <div className="card" style={{ marginTop: 10, padding: 0, overflow: "hidden" }}>
            <div style={{ background: "var(--navy)", color: "#fff", padding: "18px 20px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#A9BBD0" }}><span>ΚΑΡΤΑ ΕΠΙΒΙΒΑΣΗΣ</span><span>{open.airline}</span></div>
              <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 12 }}>
                <div><div style={{ fontSize: 30, fontWeight: 800 }}>{open.origin}</div><div style={{ fontSize: 12, color: "#A9BBD0" }}>{clock(open.filledOffer.depM)}</div></div>
                <div style={{ flex: 1, borderTop: "1px dashed #3B5470", textAlign: "center", color: "#A9BBD0", lineHeight: 0 }}><span style={{ background: "var(--navy)", padding: "0 8px", lineHeight: 1 }}>✈</span></div>
                <div style={{ textAlign: "right" }}><div style={{ fontSize: 30, fontWeight: 800 }}>{open.dest}</div><div style={{ fontSize: 12, color: "#A9BBD0" }}>{clock(open.filledOffer.arrM)}</div></div>
              </div>
            </div>
            <div style={{ padding: 20 }}>
              <div className="grid2" style={{ rowGap: 14 }}>
                {[["Επιβάτης", open.pax.name], ["Πτήση", open.code], ["Ημερομηνία", new Date(open.dateISO).toLocaleDateString("el-GR", { day: "numeric", month: "long", year: "numeric" })], ["Θέση", "στο check-in"]].map(([k, v]) => (
                  <div key={k}><div className="lbl">{k}</div><div style={{ fontWeight: 700, marginTop: 2 }}>{v}</div></div>
                ))}
              </div>
              <div className="grid2" style={{ marginTop: 16 }}>
                <div className="kv"><label>Πληρώθηκε</label><div>{eur(open.filledPrice)}</div></div>
                {!open.instant && open.entry > open.filledPrice && <div className="kv" style={{ background: "#E3F6F4" }}><label>Γλίτωσες</label><div style={{ color: "var(--teal)" }}>{eur(open.entry - open.filledPrice)}</div></div>}
              </div>
              <div style={{ borderTop: "1px dashed var(--line)", margin: "18px 0" }} />
              <div className="lbl">Κωδικός κράτησης</div>
              <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: "5px", margin: "4px 0 12px" }}>{open.ref}</div>
              <svg viewBox="0 0 300 46" style={{ width: "100%", height: 46 }}>
                {Array.from({ length: 74 }, (_, i) => <rect key={i} x={i * 4} y="0" width={rnd(hash(open.ref) + i) > 0.5 ? 2.4 : 1.1} height="46" fill="#05203C" />)}
              </svg>
              <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                <button className="btn btn-blue">Online check-in</button><button className="btn btn-line">Λήψη PDF</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ---------- EXPLORE ---------- */}
      {page === "explore" && (
        <div className="wrap" style={{ paddingTop: 22, paddingBottom: 60 }}>
          <h2 className="sec-h" style={{ marginTop: 0 }}>Απευθείας από {city(origin)}</h2>
          <p className="sec-p">{destinations.length} προορισμοί, ο καθένας στη φθηνότερη ημέρα του μέσα στις επόμενες έξι εβδομάδες. <button className="link" onClick={() => { setPicker("from"); setQuery(""); setPage("picker"); }}>Αλλαγή αεροδρομίου</button></p>
          <div className="tiles">
            {destinations.map((d, i) => (
              <button key={d.code} className="tile" onClick={() => { setDest(d.code); setDate(d.date); setPage("results"); }}>
                <CityImage code={d.code} />
                <div className="body">
                  <div className="row"><span className="muted">{d.country}</span><span className="price">{eur(d.price)}</span></div>
                  <div className="muted" style={{ marginTop: 4 }}>{d.date.toLocaleDateString("el-GR", { day: "numeric", month: "short" })} · {d.km} χλμ</div>
                  {i === 0 && <div className="tag tag-green" style={{ marginTop: 8 }}>Φθηνότερο</div>}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
