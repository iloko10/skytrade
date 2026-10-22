from dataclasses import dataclass, asdict
from datetime import date
from typing import Protocol


@dataclass
class Offer:
    offer_id: str
    origin: str
    destination: str
    depart_date: str
    airline: str
    flight_code: str
    departure_time: str
    arrival_time: str
    duration: str
    stops: int
    price: float
    currency: str = "EUR"

    def dict(self) -> dict:
        return asdict(self)


class FlightProvider(Protocol):
    name: str

    def search(
        self,
        origin: str,
        destination: str,
        depart_date: date,
        adults: int = 1,
        cabin: str = "ECONOMY",
        max_stops: int = 0,
    ) -> list[Offer]:
        """Return today's offers for a route, cheapest first."""
        ...
