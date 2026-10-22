import logging
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import predictor
from .config import settings
from .db import get_db, init_db
from .engine import check_order, poll_once, provider
from .models import Notification, Order, PriceTick
from .schemas import NotificationOut, OrderCreate, OrderOut

logging.basicConfig(level=logging.INFO)
scheduler = BackgroundScheduler()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    scheduler.add_job(poll_once, "interval", minutes=settings.poll_minutes, id="watch")
    scheduler.start()
    yield
    scheduler.shutdown(wait=False)


app = FastAPI(title="SkyTrade API", version="0.2.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"ok": True, "provider": provider.name, "poll_minutes": settings.poll_minutes}


# ---------- search ----------


@app.get("/search")
def search(
    origin: str,
    destination: str,
    depart_date: date,
    adults: int = 1,
    cabin: str = "ECONOMY",
    max_stops: int = 0,
    db: Session = Depends(get_db),
):
    offers = provider.search(origin.upper(), destination.upper(), depart_date, adults, cabin, max_stops)
    if offers:
        best = offers[0]
        db.add(
            PriceTick(
                origin=origin.upper(),
                destination=destination.upper(),
                depart_date=depart_date,
                price=best.price,
                currency=best.currency,
                airline=best.airline,
                flight_code=best.flight_code,
                offer_id=best.offer_id,
            )
        )
        db.commit()
    return {"offers": [o.dict() for o in offers]}


@app.get("/calendar")
def calendar(origin: str, destination: str, start: date | None = None, days: int = Query(30, le=60)):
    """Cheapest fare for each day — this is what the date picker shows."""
    start = start or date.today() + timedelta(days=1)
    return {"days": predictor.price_calendar(provider, origin.upper(), destination.upper(), start, days)}


# ---------- price outlook ----------


@app.get("/outlook")
def outlook(origin: str, destination: str, depart_date: date, db: Session = Depends(get_db)):
    ticks = db.scalars(
        select(PriceTick)
        .where(
            PriceTick.origin == origin.upper(),
            PriceTick.destination == destination.upper(),
            PriceTick.depart_date == depart_date,
        )
        .order_by(PriceTick.observed_at)
    ).all()
    return predictor.outlook(ticks)


@app.get("/history")
def history(origin: str, destination: str, depart_date: date, db: Session = Depends(get_db)):
    ticks = db.scalars(
        select(PriceTick)
        .where(
            PriceTick.origin == origin.upper(),
            PriceTick.destination == destination.upper(),
            PriceTick.depart_date == depart_date,
        )
        .order_by(PriceTick.observed_at)
    ).all()
    return {
        "points": [
            {"t": t.observed_at.isoformat(), "price": t.price, "airline": t.airline, "code": t.flight_code}
            for t in ticks
        ]
    }


# ---------- orders ----------


@app.post("/orders", response_model=OrderOut)
def create_order(payload: OrderCreate, db: Session = Depends(get_db)):
    if payload.limit_price > settings.max_order_price:
        raise HTTPException(400, f"Limit above the safety cap of €{settings.max_order_price:.0f}.")
    if payload.depart_date <= date.today():
        raise HTTPException(400, "Departure date must be in the future.")

    # Never watch past three days before departure — too late to be useful.
    hard_stop = datetime.combine(payload.depart_date - timedelta(days=3), datetime.min.time())
    expires = min(datetime.utcnow() + timedelta(days=payload.watch_days), hard_stop)
    if expires <= datetime.utcnow():
        raise HTTPException(400, "That departure is too close to watch.")

    order = Order(
        user_email=payload.user_email,
        origin=payload.origin.upper(),
        destination=payload.destination.upper(),
        depart_date=payload.depart_date,
        return_date=payload.return_date,
        adults=payload.adults,
        cabin=payload.cabin,
        max_stops=payload.max_stops,
        limit_price=payload.limit_price,
        expires_at=expires,
    )
    db.add(order)
    db.commit()

    check_order(db, order)  # first check immediately, so it can fill right away
    db.commit()
    db.refresh(order)
    return order


@app.get("/orders", response_model=list[OrderOut])
def list_orders(user_email: str, db: Session = Depends(get_db)):
    return db.scalars(
        select(Order).where(Order.user_email == user_email).order_by(Order.created_at.desc())
    ).all()


@app.get("/orders/{order_id}", response_model=OrderOut)
def get_order(order_id: int, db: Session = Depends(get_db)):
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(404, "Order not found.")
    return order


@app.patch("/orders/{order_id}", response_model=OrderOut)
def update_limit(order_id: int, limit_price: float, db: Session = Depends(get_db)):
    order = db.get(Order, order_id)
    if not order or order.status != "watching":
        raise HTTPException(400, "Only a watching order can be changed.")
    order.limit_price = limit_price
    db.commit()
    check_order(db, order)
    db.commit()
    db.refresh(order)
    return order


@app.delete("/orders/{order_id}")
def cancel_order(order_id: int, db: Session = Depends(get_db)):
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(404, "Order not found.")
    if order.status != "watching":
        raise HTTPException(400, "This order is not watching any more.")
    order.status = "cancelled"
    db.commit()
    return {"status": "cancelled", "charged": 0}


@app.post("/orders/{order_id}/check")
def check_now(order_id: int, db: Session = Depends(get_db)):
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(404, "Order not found.")
    result = check_order(db, order)
    db.commit()
    return {"result": result, "status": order.status, "filled_price": order.filled_price}


@app.post("/admin/poll")
def force_poll():
    """Run the watcher right now instead of waiting for the scheduler."""
    return poll_once()


# ---------- notifications ----------


@app.get("/notifications", response_model=list[NotificationOut])
def notifications(user_email: str, db: Session = Depends(get_db)):
    return db.scalars(
        select(Notification)
        .where(Notification.user_email == user_email)
        .order_by(Notification.created_at.desc())
        .limit(50)
    ).all()


@app.post("/notifications/{note_id}/read")
def mark_read(note_id: int, db: Session = Depends(get_db)):
    note = db.get(Notification, note_id)
    if not note:
        raise HTTPException(404, "Notification not found.")
    note.read = True
    db.commit()
    return {"ok": True}
