"""Entry point for the AI Telegram bot."""

import asyncio
import logging

from bot.database.repository import repository
from bot.handlers.telegram import telegram_client
from bot.polling import start_polling

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logging.getLogger("bot.ai").setLevel(logging.DEBUG)
logger = logging.getLogger(__name__)


async def main() -> None:
    """Initialize and run the bot."""
    logger.info("Initializing database...")
    await repository.init_db()

    logger.info("Starting bot...")
    try:
        await start_polling()
    finally:
        logger.info("Shutting down...")
        await telegram_client.close()


if __name__ == "__main__":
    asyncio.run(main())
