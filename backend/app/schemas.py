from datetime import date, datetime

from pydantic import BaseModel, EmailStr, Field


class OrderCreate(BaseModel):
    user_email: EmailStr
    origin: str = Field(min_length=3, max_length=3)
    destination: str = Field(min_length=3, max_length=3)
    depart_date: date
    return_date: date | None = None
    adults: int = Field(default=1, ge=1, le=9)
    cabin: str = "ECONOMY"
    max_stops: int = Field(default=0, ge=0, le=2)
    limit_price: float = Field(gt=0)
    watch_days: int = Field(default=14, ge=1, le=120)


class OrderOut(BaseModel):
    id: int
    user_email: str
    origin: str
    destination: str
    depart_date: date
    return_date: date | None
    adults: int
    cabin: str
    limit_price: float
    currency: str
    entry_price: float | None
    status: str
    expires_at: datetime
    created_at: datetime
    filled_price: float | None
    filled_at: datetime | None
    booking_ref: str | None

    class Config:
        from_attributes = True


class NotificationOut(BaseModel):
    id: int
    order_id: int | None
    kind: str
    message: str
    created_at: datetime
    read: bool

    class Config:
        from_attributes = True
