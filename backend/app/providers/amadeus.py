"""Real fares from the Amadeus Self-Service API.

Free test keys: https://developers.amadeus.com  ->  create an app, copy the
API key and secret into .env. The test environment returns cached real fares,
which is enough to run the whole watcher end to end.
"""

import time
from datetime import date

import httpx

from ..config import settings
from .base import Offer


def _iso_duration(value: str) -> str:
    # "PT2H15M" -> "2h 15m"
    out, num = "", ""
    for ch in value.replace("PT", ""):
        if ch.isdigit():
            num += ch
        elif ch == "H":
            out += f"{num}h "
            num = ""
        elif ch == "M":
            out += f"{num}m"
            num = ""
    return out.strip() or value


class AmadeusProvider:
    name = "amadeus"

    def __init__(self) -> None:
        self._token = ""
        self._expires = 0.0
        self._client = httpx.Client(timeout=20.0)

    def _auth(self) -> str:
        if self._token and time.time() < self._expires - 60:
            return self._token
        if not settings.amadeus_key or not settings.amadeus_secret:
            raise RuntimeError("Amadeus keys missing. Set SKYTRADE_AMADEUS_KEY and SKYTRADE_AMADEUS_SECRET.")

        r = self._client.post(
            f"{settings.amadeus_base}/v1/security/oauth2/token",
            data={
                "grant_type": "client_credentials",
                "client_id": settings.amadeus_key,
                "client_secret": settings.amadeus_secret,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        r.raise_for_status()
        data = r.json()
        self._token = data["access_token"]
        self._expires = time.time() + data.get("expires_in", 1799)
        return self._token

    def search(
        self,
        origin: str,
        destination: str,
        depart_date: date,
        adults: int = 1,
        cabin: str = "ECONOMY",
        max_stops: int = 0,
    ) -> list[Offer]:
        params = {
            "originLocationCode": origin,
            "destinationLocationCode": destination,
            "departureDate": depart_date.isoformat(),
            "adults": adults,
            "travelClass": cabin,
            "currencyCode": "EUR",
            "max": 20,
        }
        if max_stops == 0:
            params["nonStop"] = "true"

        r = self._client.get(
            f"{settings.amadeus_base}/v2/shopping/flight-offers",
            params=params,
            headers={"Authorization": f"Bearer {self._auth()}"},
        )
        r.raise_for_status()
        payload = r.json()
        carriers = payload.get("dictionaries", {}).get("carriers", {})

        offers: list[Offer] = []
        for raw in payload.get("data", []):
            itin = raw["itineraries"][0]
            segs = itin["segments"]
            first, last = segs[0], segs[-1]
            code = first["carrierCode"]
            offers.append(
                Offer(
                    offer_id=raw["id"],
                    origin=origin,
                    destination=destination,
                    depart_date=depart_date.isoformat(),
                    airline=carriers.get(code, code),
                    flight_code=f"{code} {first['number']}",
                    departure_time=first["departure"]["at"][11:16],
                    arrival_time=last["arrival"]["at"][11:16],
                    duration=_iso_duration(itin["duration"]),
                    stops=len(segs) - 1,
                    price=float(raw["price"]["grandTotal"]),
                    currency=raw["price"].get("currency", "EUR"),
                )
            )

        return sorted(offers, key=lambda o: o.price)


def get_provider():
    if settings.provider == "amadeus":
        return AmadeusProvider()
    from .mock import MockProvider

    return MockProvider()
