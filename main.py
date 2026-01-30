"""Entry point for the AI Telegram bot."""

import asyncio
import logging

from aiogram.types import BotCommand, BotCommandScopeChat, BotCommandScopeDefault

from bot.config import settings
from bot.database.repository import repository
from bot.i18n import Language, get_text
from bot.telegram import bot, dp

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logging.getLogger("bot.ai").setLevel(logging.DEBUG)
logger = logging.getLogger(__name__)

# User commands (visible to everyone)
USER_COMMAND_KEYS = [
    ("start", "cmd_start_desc"),
    ("help", "cmd_help_desc"),
    ("thinking", "cmd_thinking_desc"),
    ("redo", "cmd_redo_desc"),
    ("edit", "cmd_edit_desc"),
    ("lang", "cmd_lang_desc"),
    ("code", "cmd_code_desc"),
]

# Admin commands (only visible to admins)
ADMIN_COMMAND_KEYS = [
    ("invite", "cmd_invite_desc"),
    ("invites", "cmd_invites_desc"),
    ("deleteinvite", "cmd_deleteinvite_desc"),
    ("approve", "cmd_approve_desc"),
]


def make_commands(keys: list[tuple[str, str]], lang: Language) -> list[BotCommand]:
    """Build BotCommand list from command key pairs."""
    return [
        BotCommand(command=cmd, description=get_text(desc_key, lang))
        for cmd, desc_key in keys
    ]


async def set_bot_commands() -> None:
    """Register bot commands for each supported language."""
    for lang in Language:
        user_commands = make_commands(USER_COMMAND_KEYS, lang)
        await bot.set_my_commands(
            user_commands,
            scope=BotCommandScopeDefault(),
            language_code=lang.value,
        )

        all_commands = user_commands + make_commands(ADMIN_COMMAND_KEYS, lang)
        for admin_id in settings.admin_ids:
            await bot.set_my_commands(
                all_commands,
                scope=BotCommandScopeChat(chat_id=admin_id),
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
        await dp.start_polling(bot, allowed_updates=["message", "callback_query", "inline_query", "chosen_inline_result"])
    finally:
        logger.info("Shutting down...")
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
