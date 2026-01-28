"""Command handlers for the Telegram bot."""

import logging
import time

from aiogram import Bot, Router
from aiogram.filters import Command, CommandStart
from aiogram.types import Message

from bot.database.repository import repository

logger = logging.getLogger(__name__)

router = Router(name="commands")


def _generate_draft_id() -> int:
    """Generate a unique draft ID."""
    return int(time.time() * 1000) % (2**31 - 1)


@router.message(CommandStart())
async def cmd_start(message: Message) -> None:
    """Handle /start command."""
    await message.answer(
        "Hello\\! I'm an AI assistant\\. Send me a message, image, or PDF and I'll respond\\.",
    )


@router.message(Command("thinking"))
async def cmd_thinking(message: Message, bot: Bot) -> None:
    """Handle /thinking command to toggle thinking traces."""
    if not message.from_user:
        return

    telegram_id = message.from_user.id
    chat_id = message.chat.id
    thread_id = message.message_thread_id

    draft_id = _generate_draft_id()

    await bot.send_message_draft(
        chat_id=chat_id,
        draft_id=draft_id,
        text="Toggling thinking traces\\.\\.\\.",
        message_thread_id=thread_id,
    )

    async with repository.session_factory() as session:
        await repository.get_or_create_user(
            session,
            telegram_id,
            message.from_user.username,
            message.from_user.first_name,
        )
        new_value = await repository.toggle_show_thinking(session, telegram_id)
        await session.commit()

    status = "enabled" if new_value else "disabled"
    await message.answer(
        f"Thinking traces {status}\\.",
    )
