"""Entry point for the AI Telegram bot."""

import asyncio
import logging

from aiogram.types import BotCommand, BotCommandScopeDefault

from bot.database.repository import repository
from bot.i18n import Language, get_text
from bot.telegram import bot, dp

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logging.getLogger("bot.ai").setLevel(logging.DEBUG)
logger = logging.getLogger(__name__)


async def set_bot_commands() -> None:
    """Register bot commands for each supported language."""
    commands_keys = [
        ("start", "cmd_start_desc"),
        ("help", "cmd_help_desc"),
        ("thinking", "cmd_thinking_desc"),
        ("redo", "cmd_redo_desc"),
        ("edit", "cmd_edit_desc"),
        ("lang", "cmd_lang_desc"),
    ]

    for lang in Language:
        commands = [
            BotCommand(command=cmd, description=get_text(desc_key, lang))
            for cmd, desc_key in commands_keys
        ]
        await bot.set_my_commands(
            commands,
            scope=BotCommandScopeDefault(),
            language_code=lang.value,
        )

    logger.info("Bot commands registered for all languages")


async def main() -> None:
    """Initialize and run the bot."""
    logger.info("Initializing database...")
    await repository.init_db()

    logger.info("Setting bot commands...")
    await set_bot_commands()

    logger.info("Starting bot...")
    try:
        await dp.start_polling(bot, allowed_updates=["message", "callback_query"])
    finally:
        logger.info("Shutting down...")
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
