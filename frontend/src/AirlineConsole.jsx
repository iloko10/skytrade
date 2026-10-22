import { useState, useMemo } from "react";

/* ===== theme: airline ops console (deliberately not the consumer app) ===== */
const K = {
  bg: "#0F1620", panel: "#16202C", panel2: "#1C2836", line: "#2A3949",
  text: "#E6EDF5", mut: "#7D91A8", teal: "#2DC5B6", amber: "#F0A93B",
  red: "#EF6B5E", green: "#4ADE9B",
};
const MONO = "ui-monospace,'SF Mono','JetBrains Mono',Menlo,Consolas,monospace";
const SANS = "'Inter','Segoe UI',system-ui,-apple-system,sans-serif";
const eur = (n) => "€" + Math.round(n).toLocaleString("el-GR");
const pct = (n) => Math.round(n * 100) + "%";

const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const rnd = (n) => { let t = (n + 0x6d2b79f5) >>> 0; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/* ===== simulated flight book ===== */
const ROUTES = [
  ["ATH", "NAP", "A3 690", 180], ["ATH", "LGW", "A3 600", 186], ["ATH", "CDG", "A3 610", 174],
  ["ATH", "MUC", "A3 570", 168], ["SKG", "BER", "A3 906", 162], ["ATH", "FCO", "A3 650", 180],
  ["ATH", "MAD", "A3 680", 174], ["SKG", "LGW", "A3 916", 168],
];

function buildFlights() {
  return ROUTES.map(([from, to, code, cap], i) => {
    const s = hash(from + to + code);
    const daysOut = 4 + Math.floor(rnd(s) * 40);
    const load = 0.42 + rnd(s + 1) * 0.5;
    const sold = Math.round(cap * load);
    const fare = 60 + Math.round(rnd(s + 2) * 18) * 5;

    // Open limit orders, bucketed by price. More demand as the price falls.
    const buckets = [];
    for (let b = 0; b < 8; b++) {
      const price = fare - (b + 1) * 5 - Math.floor(rnd(s + b) * 5);
      const seats = Math.max(0, Math.round((b + 1) * (1.6 + rnd(s + b * 7) * 3.4)));
      buckets.push({ price, seats });
    }
    return {
      id: code + i, from, to, code, cap, sold, fare, daysOut,
      dep: `${String(6 + Math.floor(rnd(s + 4) * 14)).padStart(2, "0")}:${String(Math.floor(rnd(s + 5) * 6)) + "5"}`,
      orders: buckets.sort((a, b) => b.price - a.price),
      revenue: Math.round(cap * load * fare * (0.86 + rnd(s + 6) * 0.2)),
    };
  });
}

/* ===== small parts ===== */
const Lab = ({ children, style }) => <div style={{ fontFamily: MONO, fontSize: 9, letterSpacing: "1.2px", color: K.mut, textTransform: "uppercase", ...style }}>{children}</div>;

const Stat = ({ label, value, color, sub }) => (
  <div style={{ background: K.panel2, border: `1px solid ${K.line}`, borderRadius: 8, padding: "11px 13px" }}>
    <Lab>{label}</Lab>
    <div style={{ fontFamily: MONO, fontSize: 20, fontWeight: 700, color: color || K.text, marginTop: 4 }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: K.mut, marginTop: 3 }}>{sub}</div>}
  </div>
);

/* ===== demand curve ===== */
function DemandCurve({ orders, fare, release, capacityLeft }) {
  const W = 560, H = 230, PL = 42, PR = 16, PT = 16, PB = 34;
  const prices = orders.map((o) => o.price);
  const minP = Math.min(...prices) - 5, maxP = fare + 5;
  const maxSeats = Math.max(...orders.map((o) => o.seats), 1);

  const x = (p) => PL + ((p - minP) / (maxP - minP)) * (W - PL - PR);
  const y = (s) => PT + (1 - s / (maxSeats * 1.15)) * (H - PT - PB);

  // cumulative: seats that fill if the fare drops to p
  const cum = (p) => orders.filter((o) => o.price >= p).reduce((s, o) => s + o.seats, 0);
  const maxCum = cum(minP);
  const yc = (s) => PT + (1 - s / (maxCum * 1.1 || 1)) * (H - PT - PB);
  const curve = orders.map((o, i) => `${i === 0 ? "M" : "L"}${x(o.price)},${yc(cum(o.price))}`).join(" ");

  const bw = ((W - PL - PR) / (orders.length + 2)) * 0.72;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }}>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={PL} x2={W - PR} y1={PT + f * (H - PT - PB)} y2={PT + f * (H - PT - PB)} stroke={K.line} />
          <text x={PL - 8} y={PT + f * (H - PT - PB) + 3.5} textAnchor="end" fontFamily={MONO} fontSize="9" fill={K.mut}>
            {Math.round((1 - f) * maxSeats * 1.15)}
          </text>
        </g>
      ))}

      {orders.map((o) => {
        const hit = o.price >= release;
        return (
          <g key={o.price}>
            <rect x={x(o.price) - bw / 2} y={y(o.seats)} width={bw} height={H - PB - y(o.seats)} rx="2"
              fill={hit ? K.teal : K.line} opacity={hit ? 0.9 : 1} />
            <text x={x(o.price)} y={H - PB + 14} textAnchor="middle" fontFamily={MONO} fontSize="9.5" fill={hit ? K.teal : K.mut}>€{o.price}</text>
            <text x={x(o.price)} y={y(o.seats) - 5} textAnchor="middle" fontFamily={MONO} fontSize="9.5" fill={hit ? K.teal : K.mut}>{o.seats}</text>
          </g>
        );
      })}

      <path d={curve} fill="none" stroke={K.amber} strokeWidth="1.8" strokeDasharray="4 3" />

      {/* current public fare */}
      <line x1={x(fare)} x2={x(fare)} y1={PT} y2={H - PB} stroke={K.mut} strokeWidth="1" strokeDasharray="3 3" />
      <text x={x(fare) - 5} y={PT + 10} textAnchor="end" fontFamily={MONO} fontSize="9" fill={K.mut}>ΤΙΜΗ €{fare}</text>

      {/* release line */}
      <line x1={x(release)} x2={x(release)} y1={PT} y2={H - PB} stroke={K.teal} strokeWidth="2" />
      <rect x={x(release) - 30} y={PT - 6} width="60" height="18" rx="4" fill={K.teal} />
      <text x={x(release)} y={PT + 7} textAnchor="middle" fontFamily={MONO} fontSize="10" fontWeight="700" fill="#06231F">€{release}</text>

      <text x={PL} y={H - 4} fontFamily={MONO} fontSize="9" fill={K.mut}>ΤΙΜΗ ΕΝΤΟΛΗΣ →</text>
      <text x={W - PR} y={H - 4} textAnchor="end" fontFamily={MONO} fontSize="9" fill={K.amber}>
        ΣΩΡΕΥΤΙΚΑ {cum(release)} ΘΕΣΕΙΣ · ΔΙΑΘΕΣΙΜΕΣ {capacityLeft}
      </text>
    </svg>
  );
}

/* ===== console ===== */
export default function AirlineConsole() {
  const [flights, setFlights] = useState(buildFlights);
  const [selId, setSelId] = useState(null);
  const [release, setRelease] = useState(null);
  const [log, setLog] = useState([]);

  const sorted = useMemo(
    () => [...flights].sort((a, b) => (a.sold / a.cap) * a.daysOut - (b.sold / b.cap) * b.daysOut),
    [flights]
  );
  const f = flights.find((x) => x.id === selId) || sorted[0];
  const prices = f.orders.map((o) => o.price);
  const rel = release != null && prices.includes(release) ? release : prices[Math.floor(prices.length / 2)];

  const seatsLeft = f.cap - f.sold;
  const wouldFill = Math.min(seatsLeft, f.orders.filter((o) => o.price >= rel).reduce((s, o) => s + o.seats, 0));
  const instantRevenue = wouldFill * rel;
  const lockedDemand = f.orders.reduce((s, o) => s + o.seats, 0);

  // If instead the public fare were cut to this price, the seats that were
  // going to sell at full price get the discount too. That is the dilution.
  const naturalSales = Math.round(seatsLeft * Math.min(0.55, f.daysOut / 60));
  const dilution = naturalSales * (f.fare - rel);

  const totalSeatsReleased = log.reduce((s, l) => s + l.seats, 0);
  const totalRevenue = log.reduce((s, l) => s + l.revenue, 0);

  const doRelease = () => {
    setLog((l) => [{ id: Date.now(), flight: f.code, route: `${f.from}-${f.to}`, price: rel, seats: wouldFill, revenue: instantRevenue, t: new Date().toLocaleTimeString("el-GR", { hour: "2-digit", minute: "2-digit" }) }, ...l]);
    setFlights((fs) => fs.map((x) => x.id !== f.id ? x : {
      ...x, sold: x.sold + wouldFill, revenue: x.revenue + instantRevenue,
      orders: x.orders.map((o) => (o.price >= rel ? { ...o, seats: 0 } : o)),
    }));
  };

  const box = { background: K.panel, border: `1px solid ${K.line}`, borderRadius: 12, padding: 16 };

  return (
    <div style={{ minHeight: "100vh", background: K.bg, color: K.text, fontFamily: SANS, padding: "20px 16px 40px" }}>
      <style>{`
        input[type=range]{-webkit-appearance:none;appearance:none;height:4px;background:${K.line};border-radius:3px;outline:none}
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:20px;height:20px;border-radius:50%;background:${K.teal};cursor:pointer;border:3px solid ${K.bg}}
        input[type=range]::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:${K.teal};cursor:pointer;border:3px solid ${K.bg}}
        button:focus-visible{outline:2px solid ${K.teal};outline-offset:2px}
      `}</style>

      <div style={{ maxWidth: 1120, margin: "0 auto" }}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 12, paddingBottom: 16, borderBottom: `1px solid ${K.line}`, marginBottom: 18 }}>
          <div>
            <div style={{ fontFamily: MONO, fontSize: 18, fontWeight: 700 }}>REVENUE CONSOLE</div>
            <div style={{ fontSize: 12, color: K.mut, marginTop: 3 }}>Ζήτηση από εντολές αγοράς · powered by SkyTrade</div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <Stat label="θέσεις που πουλήθηκαν εδώ" value={totalSeatsReleased} color={K.teal} />
            <Stat label="έσοδα από εντολές" value={eur(totalRevenue)} color={K.teal} />
          </div>
        </header>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 340px) 1fr", gap: 16, alignItems: "start" }}>

          {/* flight list */}
          <div style={box}>
            <Lab style={{ marginBottom: 10 }}>πτήσεις σε κίνδυνο · πιο επείγουσα πρώτη</Lab>
            {sorted.map((x) => {
              const load = x.sold / x.cap;
              const on = x.id === f.id;
              const open = x.orders.reduce((s, o) => s + o.seats, 0);
              return (
                <button key={x.id} onClick={() => { setSelId(x.id); setRelease(null); }}
                  style={{ display: "block", width: "100%", textAlign: "left", background: on ? K.panel2 : "transparent", border: `1px solid ${on ? K.teal : K.line}`, borderRadius: 9, padding: "11px 12px", marginBottom: 8, cursor: "pointer", color: K.text, fontFamily: SANS }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 13.5 }}>{x.from}–{x.to}</span>
                    <span style={{ fontFamily: MONO, fontSize: 10, color: x.daysOut < 10 ? K.red : K.mut }}>Τ−{x.daysOut}</span>
                  </div>
                  <div style={{ fontSize: 11, color: K.mut, marginTop: 2 }}>{x.code} · {x.dep} · {eur(x.fare)}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                    <div style={{ flex: 1, height: 4, background: K.line, borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ width: pct(load), height: "100%", background: load < 0.6 ? K.red : load < 0.8 ? K.amber : K.green }} />
                    </div>
                    <span style={{ fontFamily: MONO, fontSize: 10, color: K.mut }}>{pct(load)}</span>
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 10, color: open ? K.teal : K.mut, marginTop: 6 }}>{open} θέσεις ζητούνται χαμηλότερα</div>
                </button>
              );
            })}
          </div>

          {/* main */}
          <div style={{ display: "grid", gap: 16 }}>
            <div style={box}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
                <div>
                  <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700 }}>{f.from} → {f.to}</div>
                  <div style={{ fontSize: 12, color: K.mut, marginTop: 3 }}>{f.code} · αναχώρηση {f.dep} · σε {f.daysOut} μέρες</div>
                </div>
                <div style={{ fontFamily: MONO, fontSize: 12, color: K.mut }}>{f.sold}/{f.cap} θέσεις</div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 10, marginTop: 14 }}>
                <Stat label="πληρότητα" value={pct(f.sold / f.cap)} color={f.sold / f.cap < 0.6 ? K.red : f.sold / f.cap < 0.8 ? K.amber : K.green} sub={`${seatsLeft} κενές`} />
                <Stat label="τρέχουσα τιμή" value={eur(f.fare)} />
                <Stat label="κλειδωμένη ζήτηση" value={`${lockedDemand} θέσεις`} color={K.teal} sub="εντολές που περιμένουν" />
                <Stat label="έσοδα πτήσης" value={eur(f.revenue)} />
              </div>
            </div>

            <div style={box}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <Lab>καμπύλη ζήτησης — πόσες θέσεις πουλάνε σε κάθε τιμή</Lab>
                <Lab style={{ color: K.amber }}>‑ ‑ σωρευτικά</Lab>
              </div>
              <DemandCurve orders={f.orders} fare={f.fare} release={rel} capacityLeft={seatsLeft} />

              <div style={{ marginTop: 14, padding: "14px 0 0", borderTop: `1px solid ${K.line}` }}>
                <Lab style={{ marginBottom: 10 }}>προσομοίωση απελευθέρωσης θέσεων</Lab>
                <input type="range" min={0} max={prices.length - 1} value={prices.indexOf(rel)}
                  onChange={(e) => setRelease(prices[Number(e.target.value)])}
                  style={{ width: "100%", marginBottom: 14 }} />

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10 }}>
                  <Stat label="τιμή απελευθέρωσης" value={eur(rel)} color={K.teal} />
                  <Stat label="θέσεις που κλείνουν αμέσως" value={wouldFill} color={K.teal} />
                  <Stat label="άμεσα έσοδα" value={eur(instantRevenue)} color={K.teal} />
                  <Stat label="αν έριχνες δημόσια την τιμή" value={`−${eur(dilution)}`} color={K.red} sub={`${naturalSales} θέσεις θα πουλούσαν έτσι κι αλλιώς`} />
                </div>

                <div style={{ background: K.panel2, border: `1px solid ${K.line}`, borderRadius: 9, padding: 13, marginTop: 12, fontSize: 12.5, lineHeight: 1.6, color: K.mut }}>
                  Η έκπτωση πάει <b style={{ color: K.text }}>μόνο σε όσους έχουν ήδη δεσμευτεί</b> στα {eur(rel)}. Η δημόσια τιμή μένει στα {eur(f.fare)},
                  οπότε δεν χάνεις έσοδα από όσους θα πλήρωναν ολόκληρη την τιμή, και δεν φαίνεται πουθενά προσφορά.
                </div>

                <button onClick={doRelease} disabled={wouldFill === 0}
                  style={{ width: "100%", marginTop: 12, background: wouldFill ? K.teal : K.line, color: wouldFill ? "#06231F" : K.mut, border: "none", borderRadius: 9, padding: "13px", fontSize: 14.5, fontWeight: 700, fontFamily: SANS, cursor: wouldFill ? "pointer" : "default" }}>
                  {wouldFill ? `Απελευθέρωση ${wouldFill} θέσεων στα ${eur(rel)} → ${eur(instantRevenue)}` : "Καμία εντολή σε αυτή την τιμή"}
                </button>
              </div>
            </div>

            <div style={box}>
              <Lab style={{ marginBottom: 10 }}>ιστορικό απελευθερώσεων</Lab>
              {log.length === 0 ? (
                <div style={{ fontSize: 12.5, color: K.mut, lineHeight: 1.6 }}>
                  Καμία ακόμα. Διάλεξε πτήση αριστερά, σύρε τον διακόπτη σε μια τιμή και πάτα απελευθέρωση — οι θέσεις πουλιούνται στιγμιαία σε όσους έχουν ήδη εντολή.
                </div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: MONO, fontSize: 12 }}>
                  <thead><tr style={{ color: K.mut }}>
                    {["ώρα", "πτήση", "τιμή", "θέσεις", "έσοδα"].map((h) => <th key={h} style={{ textAlign: "left", fontWeight: 400, fontSize: 9, letterSpacing: "1.2px", textTransform: "uppercase", paddingBottom: 8 }}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {log.map((l) => (
                      <tr key={l.id} style={{ borderTop: `1px solid ${K.line}` }}>
                        <td style={{ padding: "9px 0", color: K.mut }}>{l.t}</td>
                        <td>{l.route} {l.flight}</td>
                        <td>{eur(l.price)}</td>
                        <td style={{ color: K.teal }}>+{l.seats}</td>
                        <td style={{ color: K.teal }}>{eur(l.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>

        <div style={{ ...box, marginTop: 16 }}>
          <Lab style={{ marginBottom: 8 }}>τι αλλάζει αυτό για την εταιρεία</Lab>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 16, fontSize: 12.5, lineHeight: 1.6, color: K.mut }}>
            <div><b style={{ color: K.text }}>Βλέπει τη ζήτηση πριν πουλήσει.</b> Σήμερα το revenue management μαντεύει πόσοι θα αγόραζαν στα 85. Εδώ το ξέρει ακριβώς, ανά πτήση και ανά ημερομηνία.</div>
            <div><b style={{ color: K.text }}>Γεμίζει θέσεις χωρίς να κάψει την τιμή.</b> Η έκπτωση δίνεται σημειακά σε δεσμευμένους πελάτες, όχι σε όλη την αγορά.</div>
            <div><b style={{ color: K.text }}>Κρατάει τον πελάτη μέσα.</b> Όποιος βάζει εντολή δεν ψάχνει αλλού — έχει ήδη δώσει κάρτα και περιμένει αυτή την πτήση.</div>
          </div>
        </div>
      </div>
    </div>
  );
}
