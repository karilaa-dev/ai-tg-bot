"""Command handlers for the Telegram bot."""

import logging

from aiogram import Bot, Router
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import Command, CommandStart
from aiogram.types import Message

from bot.database.repository import repository
from bot.telegram.handlers.messages import _format_history, generate_and_stream_response
from bot.utils import trim_messages_to_limit

logger = logging.getLogger(__name__)

router = Router(name="commands")


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
    await message.answer(f"Thinking traces {status}\\.")


async def _delete_telegram_message(bot: Bot, chat_id: int, message_id: int) -> None:
    """Delete a Telegram message, ignoring errors for old or already deleted messages."""
    try:
        await bot.delete_message(chat_id, message_id)
    except TelegramBadRequest as e:
        logger.debug(f"Could not delete message {message_id}: {e}")


async def _handle_redo_latest(
    message: Message, bot: Bot, new_prompt: str | None = None
) -> None:
    """Delete latest assistant response and regenerate."""
    if not message.from_user:
        return

    chat_id = message.chat.id
    thread_id = message.message_thread_id
    telegram_id = message.from_user.id

    async with repository.session_factory() as session:
        user = await repository.get_or_create_user(
            session, telegram_id, message.from_user.username, message.from_user.first_name
        )
        conv = await repository.get_or_create_conversation(session, user.id, chat_id, thread_id)

        # Get latest user message
        latest_user_msg = await repository.get_latest_user_message(session, conv.id)
        if not latest_user_msg:
            await message.answer("No previous message to regenerate\\.")
            return

        # Delete latest assistant response from DB and get Telegram message ID
        tg_msg_id = await repository.delete_latest_assistant_response(session, conv.id)

        # If editing, update the user message content
        if new_prompt is not None:
            latest_user_msg.content = new_prompt

        # Get updated conversation messages
        db_messages = await repository.get_conversation_messages(session, conv.id)
        show_thinking = user.show_thinking
        await session.commit()

    # Delete from Telegram
    if tg_msg_id:
        await _delete_telegram_message(bot, chat_id, tg_msg_id)

    # Prepare AI messages and regenerate
    ai_messages = trim_messages_to_limit(await _format_history(db_messages, bot))

    await bot.send_chat_action(chat_id, "typing", message_thread_id=thread_id)

    result = await generate_and_stream_response(bot, chat_id, thread_id, ai_messages, show_thinking)

    # Save new assistant response
    async with repository.session_factory() as session:
        conv = await repository.get_or_create_conversation(session, user.id, chat_id, thread_id)
        await repository.add_message(
            session,
            conv.id,
            "assistant",
            result.content,
            message_id=result.sent_message_ids[0] if result.sent_message_ids else None,
        )
        await session.commit()


@router.message(Command("redo", "regenerate"))
async def cmd_redo(message: Message, bot: Bot) -> None:
    """Handle /redo and /regenerate commands to regenerate the last response."""
    if not message.from_user:
        return
    await _handle_redo_latest(message, bot)


@router.message(Command("edit"))
async def cmd_edit(message: Message, bot: Bot) -> None:
    """Handle /edit command to regenerate with a new prompt."""
    if not message.from_user:
        return

    parts = (message.text or "").split(maxsplit=1)
    if len(parts) < 2:
        await message.answer("Usage: /edit <new prompt>")
        return

    new_prompt = parts[1]
    await _handle_redo_latest(message, bot, new_prompt)
