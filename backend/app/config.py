from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Provider: "mock" works with no API keys. "amadeus" hits the real API.
    provider: str = "mock"

    amadeus_key: str = ""
    amadeus_secret: str = ""
    # Amadeus test environment. Switch to api.amadeus.com for production.
    amadeus_base: str = "https://test.api.amadeus.com"

    database_url: str = "sqlite:///./skytrade.db"

    # How often the watcher re-checks fares, in minutes.
    poll_minutes: int = 5

    # Safety rail: an order will never be filled above this, whatever the user set.
    max_order_price: float = 2000.0

    # Real ticket issuing stays off until you have explicitly tested it.
    booking_enabled: bool = False

    class Config:
        env_file = ".env"
        env_prefix = "SKYTRADE_"


settings = Settings()
