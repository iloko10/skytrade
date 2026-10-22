"""Offline provider so the app runs with no API keys.

It imitates how airlines actually price: a seat sits in a fare class, and
when that class sells out the price jumps to the next one. So fares move in
steps, not smooth curves, and they drift upward as departure gets closer.
"""

import hashlib
import random
from datetime import date, datetime

from .base import Offer

AIRLINES = [
    ("Aegean", "A3", 1.20),
    ("Volotea", "V7", 0.85),
    ("Ryanair", "FR", 0.70),
    ("easyJet", "U2", 0.80),
    ("Transavia", "HV", 0.90),
    ("Lufthansa", "LH", 1.45),
]

BUCKET_MULTIPLIERS = [0.60, 0.72, 0.84, 1.00, 1.16, 1.34, 1.55, 1.80]
SLOT_MINUTES = 5  # one price step per 5 minutes of wall clock


def _seed(*parts) -> int:
    raw = "|".join(str(p) for p in parts).encode()
    return int(hashlib.sha256(raw).hexdigest()[:8], 16)


def _base_price(origin: str, destination: str) -> float:
    rnd = random.Random(_seed(origin, destination))
    return round(rnd.uniform(70, 260), -1)


def _walk_index(key: int, slot: int, n_buckets: int, days_out: int) -> int:
    """Deterministic random walk over fare classes, biased upward as the
    departure date approaches."""
    rnd = random.Random(key)
    idx = 3
    up_bias = 0.20 if days_out > 21 else 0.30 if days_out > 7 else 0.42
    for _ in range(slot % 4000):
        r = rnd.random()
        if r < 0.20:
            idx -= 1
        elif r < 0.20 + up_bias:
            idx += 1
        idx = max(0, min(n_buckets - 1, idx))
    return idx


class MockProvider:
    name = "mock"

    def search(
        self,
        origin: str,
        destination: str,
        depart_date: date,
        adults: int = 1,
        cabin: str = "ECONOMY",
        max_stops: int = 0,
    ) -> list[Offer]:
        base = _base_price(origin, destination)
        days_out = max(1, (depart_date - date.today()).days)
        slot = int(datetime.utcnow().timestamp() // (SLOT_MINUTES * 60))

        rnd = random.Random(_seed(origin, destination, depart_date))
        carriers = rnd.sample(AIRLINES, 4)

        offers: list[Offer] = []
        for i, (airline, code, factor) in enumerate(carriers):
            key = _seed(origin, destination, depart_date, airline)
            buckets = [round(base * factor * m / 5) * 5 for m in BUCKET_MULTIPLIERS]
            idx = _walk_index(key, slot, len(buckets), days_out)
            price = float(buckets[idx])

            r = random.Random(key)
            dep_h = r.randint(6, 20)
            dur_m = r.randint(95, 260)
            stops = 0 if r.random() < 0.75 else 1
            if stops > max_stops:
                stops = max_stops

            arr_total = dep_h * 60 + r.randint(0, 55) + dur_m
            offers.append(
                Offer(
                    offer_id=f"MOCK-{code}{1000 + i}-{depart_date}",
                    origin=origin,
                    destination=destination,
                    depart_date=depart_date.isoformat(),
                    airline=airline,
                    flight_code=f"{code} {r.randint(100, 9999)}",
                    departure_time=f"{dep_h:02d}:{r.randint(0, 5)}{r.randint(0, 9)}",
                    arrival_time=f"{(arr_total // 60) % 24:02d}:{arr_total % 60:02d}",
                    duration=f"{dur_m // 60}h {dur_m % 60:02d}m",
                    stops=stops,
                    price=price,
                    currency="EUR",
                )
            )

        return sorted(offers, key=lambda o: o.price)
