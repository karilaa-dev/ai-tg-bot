"""Command handlers for the bot."""

import logging
import time

from bot.database.repository import repository
from bot.handlers.telegram import telegram_client

logger = logging.getLogger(__name__)


async def handle_thinking_command(
    chat_id: int,
    telegram_id: int,
    message_thread_id: int | None = None,
) -> None:
    """Handle /thinking command to toggle thinking traces."""
    draft_id = int(time.time() * 1000) % (2**31 - 1)

    await telegram_client.send_message_draft(
        chat_id=chat_id,
        draft_id=draft_id,
        text="Toggling thinking traces...",
        message_thread_id=message_thread_id,
    )

    async with repository.session_factory() as session:
        new_value = await repository.toggle_show_thinking(session, telegram_id)
        await session.commit()

    status = "enabled" if new_value else "disabled"
    response_text = f"Thinking traces {status}."

    await telegram_client.send_message(
        chat_id=chat_id,
        text=response_text,
        message_thread_id=message_thread_id,
    )
