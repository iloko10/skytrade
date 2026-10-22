"""The watcher: re-checks fares for every live order and fills the ones that hit."""

import json
import logging
import random
import string
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .db import SessionLocal
from .models import Notification, Order, PriceTick
from .providers.amadeus import get_provider

log = logging.getLogger("skytrade.engine")
provider = get_provider()


def _ref() -> str:
    return "SKY" + "".join(random.choices(string.ascii_uppercase + string.digits, k=5))


def notify(db: Session, order: Order, kind: str, message: str) -> None:
    db.add(Notification(user_email=order.user_email, order_id=order.id, kind=kind, message=message))


def issue_ticket(order: Order, offer) -> str:
    """Where a real booking would happen (Amadeus Flight Create Orders or a
    Duffel order). Kept behind a flag so nothing books real money by accident."""
    if not settings.booking_enabled:
        log.info("Booking disabled — simulating ticket for order %s", order.id)
        return _ref()
    raise NotImplementedError(
        "Wire up the provider's booking endpoint here, with passenger details and payment."
    )


def check_order(db: Session, order: Order) -> str:
    """Check one order once. Returns what happened."""
    now = datetime.utcnow()

    if order.expires_at <= now:
        order.status = "expired"
        notify(db, order, "expired", f"Order {order.origin}-{order.destination} expired without filling.")
        return "expired"

    try:
        offers = provider.search(
            order.origin,
            order.destination,
            order.depart_date,
            adults=order.adults,
            cabin=order.cabin,
            max_stops=order.max_stops,
        )
    except Exception as exc:  # provider down, keep the order alive
        log.warning("Search failed for order %s: %s", order.id, exc)
        return "search_failed"

    if not offers:
        return "no_offers"

    best = offers[0]
    db.add(
        PriceTick(
            origin=order.origin,
            destination=order.destination,
            depart_date=order.depart_date,
            price=best.price,
            currency=best.currency,
            airline=best.airline,
            flight_code=best.flight_code,
            offer_id=best.offer_id,
        )
    )

    if order.entry_price is None:
        order.entry_price = best.price

    limit = min(order.limit_price, settings.max_order_price)

    if best.price <= limit:
        order.status = "filled"
        order.filled_price = best.price
        order.filled_at = now
        order.filled_offer = json.dumps(best.dict())
        order.booking_ref = issue_ticket(order, best)
        notify(
            db,
            order,
            "filled",
            f"Bought {order.origin}→{order.destination} on {order.depart_date} "
            f"at €{best.price:.0f} ({best.airline} {best.flight_code}). Ref {order.booking_ref}.",
        )
        return "filled"

    # Heads-up when it gets close, but only once.
    if best.price <= limit * 1.08:
        already = db.scalar(
            select(Notification).where(Notification.order_id == order.id, Notification.kind == "near")
        )
        if not already:
            notify(
                db,
                order,
                "near",
                f"{order.origin}→{order.destination} is €{best.price:.0f}, close to your €{limit:.0f} limit.",
            )

    return "watching"


def poll_once() -> dict:
    db = SessionLocal()
    results: dict[str, int] = {}
    try:
        orders = db.scalars(select(Order).where(Order.status == "watching")).all()
        for order in orders:
            outcome = check_order(db, order)
            results[outcome] = results.get(outcome, 0) + 1
        db.commit()
    finally:
        db.close()
    log.info("Poll done: %s", results)
    return results
