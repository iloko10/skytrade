"""Price outlook for a route.

Trains a small Random Forest on the price history we have collected for that
route and predicts where the fare goes next. With too little history it falls
back to a plain rule so the endpoint always answers something honest.
"""

from datetime import date, datetime

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor

MIN_ROWS_FOR_MODEL = 40


def _frame(ticks) -> pd.DataFrame:
    df = pd.DataFrame(
        [{"observed_at": t.observed_at, "price": t.price, "depart_date": t.depart_date} for t in ticks]
    )
    if df.empty:
        return df
    df = df.sort_values("observed_at").reset_index(drop=True)
    df["days_out"] = df.apply(lambda r: (r["depart_date"] - r["observed_at"].date()).days, axis=1)
    df["dow"] = df["observed_at"].dt.dayofweek
    df["hour"] = df["observed_at"].dt.hour
    df["roll_mean"] = df["price"].rolling(8, min_periods=1).mean()
    df["roll_min"] = df["price"].rolling(24, min_periods=1).min()
    df["roll_std"] = df["price"].rolling(8, min_periods=1).std().fillna(0)
    df["trend"] = df["price"].diff().rolling(8, min_periods=1).mean().fillna(0)
    return df


FEATURES = ["days_out", "dow", "hour", "roll_mean", "roll_min", "roll_std", "trend"]


def outlook(ticks, horizon_steps: int = 24) -> dict:
    """horizon_steps = how many observations ahead to look (24 ticks ~ 2h at
    a 5-minute poll, or a couple of days at a 1-hour poll)."""

    df = _frame(ticks)
    if df.empty:
        return {"status": "no_data", "message": "No price history for this route yet."}

    current = float(df["price"].iloc[-1])
    low = float(df["price"].min())
    high = float(df["price"].max())
    median = float(df["price"].median())
    p25 = float(np.percentile(df["price"], 25))

    # A sensible limit: the 25th percentile of what this route has actually
    # traded at, never above the price on screen right now.
    suggested_limit = round(min(p25, current * 0.92) / 5) * 5

    if len(df) < MIN_ROWS_FOR_MODEL:
        direction = "flat"
        if df["trend"].iloc[-1] > 0.5:
            direction = "rising"
        elif df["trend"].iloc[-1] < -0.5:
            direction = "falling"
        return {
            "status": "heuristic",
            "current": current,
            "low": low,
            "high": high,
            "median": median,
            "direction": direction,
            "predicted": current,
            "confidence": 0.3,
            "suggested_limit": suggested_limit,
            "samples": len(df),
            "message": "Still collecting history — this is a rough read, not a model.",
        }

    work = df.copy()
    work["future"] = work["price"].shift(-horizon_steps)
    train = work.dropna(subset=["future"])
    if len(train) < 20:
        train = work.assign(future=work["price"]).iloc[:-1]

    X = train[FEATURES].to_numpy()
    y = train["future"].to_numpy()

    model = RandomForestRegressor(n_estimators=120, max_depth=7, min_samples_leaf=2, random_state=42)
    model.fit(X, y)

    # Out-of-bag style sanity check on the last 20% of rows
    split = max(1, int(len(X) * 0.8))
    err = float(np.mean(np.abs(model.predict(X[split:]) - y[split:]))) if len(X) - split > 2 else 0.0

    predicted = float(model.predict(df[FEATURES].tail(1).to_numpy())[0])
    delta = predicted - current
    direction = "rising" if delta > max(2.0, current * 0.02) else "falling" if delta < -max(2.0, current * 0.02) else "flat"
    confidence = float(np.clip(1 - (err / max(current, 1)), 0.2, 0.95))

    advice = {
        "rising": "Fares on this route are trending up. Buying now is usually the cheaper move.",
        "falling": "Fares look like they still have room to drop. A limit order is worth placing.",
        "flat": "Fares are stable. A limit a little under today's price should still catch a dip.",
    }[direction]

    return {
        "status": "model",
        "current": current,
        "low": low,
        "high": high,
        "median": median,
        "direction": direction,
        "predicted": round(predicted, 2),
        "confidence": round(confidence, 2),
        "mean_abs_error": round(err, 2),
        "suggested_limit": suggested_limit,
        "samples": len(df),
        "message": advice,
    }


def price_calendar(provider, origin: str, destination: str, start: date, days: int = 30) -> list[dict]:
    """Cheapest fare per day, for the calendar view. With the real provider
    this is many API calls, so cache it before using it for real."""
    out = []
    for i in range(days):
        d = date.fromordinal(start.toordinal() + i)
        try:
            offers = provider.search(origin, destination, d)
        except Exception:
            continue
        if offers:
            out.append({"date": d.isoformat(), "price": offers[0].price, "airline": offers[0].airline})
    if out:
        cheapest = min(o["price"] for o in out)
        for o in out:
            o["is_cheapest"] = o["price"] == cheapest
    return out
