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


settings = Settings()
