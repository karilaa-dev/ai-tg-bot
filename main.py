"""Entry point for the AI Telegram bot."""

import asyncio
import logging

from bot.database.repository import repository
from bot.telegram import bot, dp

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
        await dp.start_polling(bot, allowed_updates=["message"])
    finally:
        logger.info("Shutting down...")
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
