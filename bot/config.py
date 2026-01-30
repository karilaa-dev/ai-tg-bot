"""Configuration management using pydantic-settings."""

from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict

load_dotenv(override=True)


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    telegram_bot_token: str
    openrouter_api_key: str
    openrouter_model: str = "moonshotai/kimi-k2.5"
    tavily_api_key: str
    database_url: str = "sqlite+aiosqlite:///bot.db"
    context_token_limit: int = 8000
    admin_ids: list[int] = []

    @classmethod
    def parse_admin_ids(cls, v: str | list[int] | None) -> list[int]:
        """Parse comma-separated admin IDs from string."""
        if v is None or v == "":
            return []
        if isinstance(v, list):
            return v
        return [int(x.strip()) for x in v.split(",") if x.strip()]

    def __init__(self, **kwargs: object) -> None:
        import os

        admin_ids_str = os.getenv("ADMIN_IDS", "")
        if admin_ids_str and "admin_ids" not in kwargs:
            kwargs["admin_ids"] = self.parse_admin_ids(admin_ids_str)
        super().__init__(**kwargs)


settings = Settings()
