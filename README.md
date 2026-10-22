# SkyTrade

Flight search with **limit orders**. You pick a route, set the price you would happily pay, and SkyTrade buys the ticket automatically the moment the fare drops to that price, the same way a limit buy works on a stock exchange.

The same idea is also built as a tool for airlines: a revenue console that shows how many seats are waiting at each price, so an airline can release seats to committed buyers without cutting the public fare.

## What is in here

| Folder | What it is |
|---|---|
| `frontend/` | React + Vite. The traveller app (`/`) and the airline revenue console (`/#console`). |
| `backend/` | FastAPI service: fare watcher, limit-order matching, price outlook (Random Forest), notifications. |

### Traveller app
- Skyscanner-style search: any of 1,219 airports, filters, "cheapest / best / fastest" tabs, price calendar, "everywhere" board
- Search works in Greek and English (Τίρανα or Tirana, Ιταλία or Italy, or an IATA code)
- Real nonstop routes; when none exists it builds one-stop trips through hubs that really connect both airports
- Draggable limit line on a step chart (fares move between fare classes, not smoothly)
- Orders list, ticket view, notifications

### Airline revenue console
Demand curve per flight, a slider to pick the release price, instant revenue, and the revenue that would be lost by cutting the public fare instead.

## Run it

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173      traveller app
                     # http://localhost:5173/#console   airline console
```

Backend (optional). With it, the app shows prices from the API and keeps limit orders on the server:

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env              # SKYTRADE_PROVIDER=mock works with no keys; amadeus needs free test keys
uvicorn app.main:app --reload     # http://127.0.0.1:8000/docs

# in another terminal
cd frontend
echo "VITE_API_URL=http://127.0.0.1:8000" > .env.local
npm run dev
```

Without `VITE_API_URL` the frontend uses its own simulated fares. If the API is set but does not answer, it falls back to the simulation and says so above the results.

## Important: what is real and what is simulated

- **Real:** airports, coordinates, nonstop routes and which airlines serve each airport (OpenFlights data).
- **Simulated:** fares and flight times. They are modelled from real distance, number of competing carriers, season and lead time. A fare in the app is not a bookable price.
- **Live mode:** with `VITE_API_URL` set, search results and orders (create / cancel / status) go through the backend. The backend serves mock fares by default, or real Amadeus test fares with `SKYTRADE_PROVIDER=amadeus`. The price calendar and the "everywhere" board still use the simulation.
- **Booking is disabled.** `issue_ticket()` returns a simulated reference. Nothing is ever purchased.
- There is no authentication yet, and passenger/payment screens are demo forms.

## City photos

City tiles are drawn illustrations. To use real photos, fill the `PHOTOS` map near the top of the artwork section in `frontend/src/App.jsx`:

```js
const PHOTOS = { NAP: "https://.../naples.jpg" };
```

## Data attribution

Airport, route and airline data comes from [OpenFlights](https://openflights.org/data.html) and is available under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/). The processed copy is `frontend/src/airportData.js`. The OpenFlights route data is a historical snapshot, so some airlines and routes are out of date.
