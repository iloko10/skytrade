from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def utcnow() -> datetime:
    return datetime.utcnow()


class Order(Base):
    """A limit order on a route. It watches every flight on that route,
    not one specific flight number."""

    __tablename__ = "orders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_email: Mapped[str] = mapped_column(String(160), index=True)

    origin: Mapped[str] = mapped_column(String(3), index=True)
    destination: Mapped[str] = mapped_column(String(3), index=True)
    depart_date: Mapped[date] = mapped_column(Date, index=True)
    return_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    adults: Mapped[int] = mapped_column(Integer, default=1)
    cabin: Mapped[str] = mapped_column(String(20), default="ECONOMY")
    max_stops: Mapped[int] = mapped_column(Integer, default=0)

    limit_price: Mapped[float] = mapped_column(Float)
    currency: Mapped[str] = mapped_column(String(3), default="EUR")
    entry_price: Mapped[float | None] = mapped_column(Float, nullable=True)

    status: Mapped[str] = mapped_column(String(16), default="watching", index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    filled_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    filled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    booking_ref: Mapped[str | None] = mapped_column(String(20), nullable=True)
    filled_offer: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON snapshot

    @property
    def route(self) -> str:
        return f"{self.origin}-{self.destination}"


class PriceTick(Base):
    """One observation of the cheapest fare on a route/date."""

    __tablename__ = "price_ticks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    origin: Mapped[str] = mapped_column(String(3), index=True)
    destination: Mapped[str] = mapped_column(String(3), index=True)
    depart_date: Mapped[date] = mapped_column(Date, index=True)
    observed_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)

    price: Mapped[float] = mapped_column(Float)
    currency: Mapped[str] = mapped_column(String(3), default="EUR")
    airline: Mapped[str] = mapped_column(String(40), default="")
    flight_code: Mapped[str] = mapped_column(String(20), default="")
    offer_id: Mapped[str] = mapped_column(String(64), default="")


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_email: Mapped[str] = mapped_column(String(160), index=True)
    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"), nullable=True)
    kind: Mapped[str] = mapped_column(String(24))  # filled | near | expired | cancelled
    message: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    read: Mapped[bool] = mapped_column(Boolean, default=False)
