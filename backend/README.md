# SkyTrade — backend

A fare watcher with limit orders. You say the price you would happily pay for a
route, and the service buys the ticket the moment the fare touches it.

The important part: this is a **route** order, not a flight order. It watches
every flight on ATH→NAP for a given date and fills on whichever one drops first.

## Run it

```bash
cd backend
python -m venv .venv && source .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload
```

Open http://127.0.0.1:8000/docs — every endpoint is testable from there.

It runs with no API keys: the default `mock` provider simulates airline pricing
(fares move in steps between fare classes and drift upward near departure).
When you want real fares, get free test keys at developers.amadeus.com, put them
in `.env`, and set `SKYTRADE_PROVIDER=amadeus`.

## What it does

- **Search** — cheapest offers per route and date, saved to the price history.
- **Calendar** — cheapest fare for each of the next 30 days, so the date picker
  can show where the cheap days are.
- **Watcher** — APScheduler re-checks every live order every 5 minutes.
- **Matching** — fills when the cheapest offer is at or below the limit; sends a
  heads-up notification when it gets within 8%.
- **Outlook** — a Random Forest trained on the collected price history predicts
  where the fare goes next, and suggests a limit (the 25th percentile of what
  the route has actually traded at). Below 40 observations it says so and falls
  back to a plain trend rule instead of pretending to be a model.
- **Expiry** — an order never outlives three days before departure.

## API

| Method | Path | What it does |
|---|---|---|
| GET | `/search` | Offers for a route and date |
| GET | `/calendar` | Cheapest fare per day, 30 days |
| GET | `/history` | Collected price ticks for a route |
| GET | `/outlook` | Price prediction + suggested limit |
| POST | `/orders` | Place a limit order (checked immediately) |
| GET | `/orders` | Orders for a user |
| PATCH | `/orders/{id}` | Change the limit |
| DELETE | `/orders/{id}` | Cancel — nothing is charged |
| POST | `/orders/{id}/check` | Force a check on one order |
| POST | `/admin/poll` | Run the watcher now |
| GET | `/notifications` | Notification feed |

Try it end to end:

```bash
curl -X POST localhost:8000/orders -H "content-type: application/json" -d '{
  "user_email": "you@example.com",
  "origin": "ATH", "destination": "NAP",
  "depart_date": "2026-11-20",
  "limit_price": 90, "watch_days": 14
}'
curl -X POST localhost:8000/admin/poll
```

## Safety rails already in place

- `max_order_price` caps what any order can ever pay.
- `booking_enabled` is off, so `issue_ticket()` returns a simulated reference
  instead of buying anything. Real issuing goes in that one function.
- Cancelling is free and instant, because no money is held — the model is
  card-on-file charged only on fill, which avoids needing an e-money licence.

## Not built yet

1. **Passengers and payment** — name, date of birth, passport, card token.
   Needed before `issue_ticket()` can call a real booking endpoint.
2. **Accounts** — right now a user is just an email string. Add auth before this
   goes anywhere public.
3. **Push notifications** — the feed exists, delivery (email/FCM) does not.
4. **Calendar caching** — `/calendar` is 30 provider calls. Cache it per day or
   you will burn the Amadeus rate limit in minutes.
