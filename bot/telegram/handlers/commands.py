"""Command handlers for the Telegram bot."""

import logging

from aiogram import Bot, Router
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import Command, CommandStart
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, Message

from bot.database.repository import repository
from bot.i18n import Language, detect_language, get_text
from bot.telegram.handlers.messages import _format_history, generate_and_stream_response
from bot.utils import trim_messages_to_limit

logger = logging.getLogger(__name__)

router = Router(name="commands")


def _build_language_keyboard() -> InlineKeyboardMarkup:
    """Build inline keyboard for language selection."""
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(text="English", callback_data="lang:en"),
                InlineKeyboardButton(text="Русский", callback_data="lang:ru"),
                InlineKeyboardButton(text="Українська", callback_data="lang:uk"),
            ]
        ]
    )


async def _get_user_lang(telegram_id: int) -> Language:
    """Get user's language preference."""
    async with repository.session_factory() as session:
        lang_code = await repository.get_user_language(session, telegram_id)
    try:
        return Language(lang_code)
    except ValueError:
        return Language.EN


@router.message(CommandStart())
async def cmd_start(message: Message) -> None:
    """Handle /start command."""
    if not message.from_user:
        return

    telegram_id = message.from_user.id

    # Detect language from Telegram settings for new users
    detected_lang = detect_language(message.from_user.language_code)

    async with repository.session_factory() as session:
        user = await repository.get_user_by_telegram_id(session, telegram_id)
        is_new_user = user is None

        await repository.get_or_create_user(
            session,
            telegram_id,
            message.from_user.username,
            message.from_user.first_name,
        )

        if is_new_user:
            await repository.update_user_language(session, telegram_id, detected_lang.value)
            lang = detected_lang
        else:
            lang = Language(user.language) if user else detected_lang

        await session.commit()

    welcome_text = get_text("start_welcome", lang)

    if is_new_user:
        # Show language selector for new users
        lang_prompt = get_text("lang_select", lang)
        await message.answer(
            f"{welcome_text}\n\n{lang_prompt}",
            parse_mode="MarkdownV2",
            reply_markup=_build_language_keyboard(),
        )
    else:
        await message.answer(welcome_text, parse_mode="MarkdownV2")


@router.message(Command("help"))
async def cmd_help(message: Message) -> None:
    """Handle /help command."""
    if not message.from_user:
        return

    lang = await _get_user_lang(message.from_user.id)
    help_text = get_text("help_text", lang)
    await message.answer(help_text, parse_mode="MarkdownV2")


@router.message(Command("lang", "language"))
async def cmd_lang(message: Message) -> None:
    """Handle /lang command to change language."""
    if not message.from_user:
        return

    lang = await _get_user_lang(message.from_user.id)
    lang_prompt = get_text("lang_select", lang)
    await message.answer(
        lang_prompt,
        parse_mode="MarkdownV2",
        reply_markup=_build_language_keyboard(),
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
        lang_code = await repository.get_user_language(session, telegram_id)
        await session.commit()

    try:
        lang = Language(lang_code)
    except ValueError:
        lang = Language.EN

    key = "thinking_enabled" if new_value else "thinking_disabled"
    await message.answer(get_text(key, lang), parse_mode="MarkdownV2")


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
            lang_code = await repository.get_user_language(session, telegram_id)
            try:
                lang = Language(lang_code)
            except ValueError:
                lang = Language.EN
            await message.answer(get_text("no_message_to_redo", lang), parse_mode="MarkdownV2")
            return

        # Delete latest assistant response from DB and get Telegram message ID
        tg_msg_id = await repository.delete_latest_assistant_response(session, conv.id)

        # If editing, update the user message content
        if new_prompt is not None:
            latest_user_msg.content = new_prompt

        # Get updated conversation messages
        db_messages = await repository.get_conversation_messages(session, conv.id)
        show_thinking = user.show_thinking
        lang = user.language
        await session.commit()

    # Delete from Telegram
    if tg_msg_id:
        await _delete_telegram_message(bot, chat_id, tg_msg_id)

    # Prepare AI messages and regenerate
    ai_messages = trim_messages_to_limit(await _format_history(db_messages, bot))

    await bot.send_chat_action(chat_id, "typing", message_thread_id=thread_id)

    result = await generate_and_stream_response(bot, chat_id, thread_id, ai_messages, show_thinking, lang)

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
        lang = await _get_user_lang(message.from_user.id)
        await message.answer(get_text("edit_usage", lang), parse_mode="MarkdownV2")
        return

    new_prompt = parts[1]
    await _handle_redo_latest(message, bot, new_prompt)
