// Talks to the SkyTrade backend. If VITE_API_URL is empty, the app falls back
// to its built-in simulated fares and none of this is used.
export const API = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

async function call(path, opts = {}) {
  const r = await fetch(API + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return r.json();
}

const qs = (o) => new URLSearchParams(o).toString();

export const api = {
  search: (origin, destination, date, maxStops = 1) =>
    call(`/search?${qs({ origin, destination, depart_date: date, max_stops: maxStops })}`),
  history: (origin, destination, date) =>
    call(`/history?${qs({ origin, destination, depart_date: date })}`),
  calendar: (origin, destination, start, days) =>
    call(`/calendar?${qs({ origin, destination, start, days })}`),
  createOrder: (body) => call("/orders", { method: "POST", body: JSON.stringify(body) }),
  listOrders: (email) => call(`/orders?${qs({ user_email: email })}`),
  cancelOrder: (id) => call(`/orders/${id}`, { method: "DELETE" }),
};

// "2h 15m" -> 135
export function minutes(text) {
  const h = /(\d+)h/.exec(text || "");
  const m = /(\d+)m/.exec(text || "");
  return (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0);
}

const clockToMin = (t) => (+t.slice(0, 2)) * 60 + (+t.slice(3, 5));

// Backend offer -> the shape the result cards already use.
export function toResult(o, history) {
  const carrier = o.flight_code.split(" ")[0];
  const price = Math.round(o.price);
  const r5 = (x) => Math.round(x / 5) * 5;
  const buckets = [...new Set([0.75, 0.85, 0.92, 1, 1.1, 1.25].map((m) => r5(price * m)))]
    .sort((a, b) => a - b);
  if (!buckets.includes(price)) buckets.push(price), buckets.sort((a, b) => a - b);
  const dur = minutes(o.duration);
  const depM = clockToMin(o.departure_time);
  const hist = history && history.length ? history : [price];
  return {
    id: o.offer_id, carrier, airline: o.airline, lowcost: false, live: true,
    code: o.flight_code, depM, dur, arrM: depM + dur,
    stops: o.stops, via: o.stops ? "·" : null, layover: 0, leg1: dur / 2, leg2: dur / 2,
    price, buckets,
    history: Array.from({ length: 40 }, (_, k) => hist[Math.max(0, hist.length - 40 + k)] ?? hist[0]),
    seatsLeft: 9,
  };
}
