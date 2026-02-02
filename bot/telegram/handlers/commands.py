"""Command handlers for the Telegram bot."""

import logging
from datetime import UTC, datetime

from aiogram import Bot, Router
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import Command, CommandStart
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, Message

from bot.config import settings
from bot.database.repository import repository
from bot.i18n import Language, detect_language, get_text, get_user_language
from bot.telegram.handlers.messages import _format_history, generate_and_stream_response
from bot.utils import trim_messages_to_limit

logger = logging.getLogger(__name__)

router = Router(name="commands")


def _build_language_keyboard() -> InlineKeyboardMarkup:
    """Build inline keyboard for language selection."""
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(text="🇬🇧 English", callback_data="lang:en"),
                InlineKeyboardButton(text="🇷🇺 Русский", callback_data="lang:ru"),
                InlineKeyboardButton(text="🇺🇦 Українська", callback_data="lang:uk"),
            ]
        ]
    )


async def _send_welcome_with_lang_select(message: Message, lang: Language, prefix: str = "") -> None:
    """Send welcome message with language selection keyboard."""
    welcome_text = get_text("start_welcome", lang)
    lang_prompt = get_text("lang_select", lang)
    full_text = f"{prefix}{welcome_text}\n\n{lang_prompt}" if prefix else f"{welcome_text}\n\n{lang_prompt}"
    await message.answer(
        full_text,
        parse_mode="MarkdownV2",
        reply_markup=_build_language_keyboard(),
    )


async def _create_user_with_language(
    session, telegram_id: int, lang: Language, invite_code: str | None = None
) -> None:
    """Create user and set language preference."""
    await repository.get_or_create_user(session, telegram_id, invited_by_code=invite_code)
    await repository.update_user_language(session, telegram_id, lang.value)


async def _validate_and_use_invite(session, invite_code: str, detected_lang: Language, message: Message) -> bool:
    """Validate invite code and show error if invalid. Returns True if valid."""
    invite = await repository.get_invite_code(session, invite_code)
    if not invite:
        await message.answer(get_text("invite_invalid", detected_lang), parse_mode="MarkdownV2")
        return False

    if invite.max_uses is not None and invite.current_uses >= invite.max_uses:
        await message.answer(get_text("invite_exhausted", detected_lang), parse_mode="MarkdownV2")
        return False

    await repository.use_invite_code(session, invite_code)
    return True


@router.message(CommandStart(deep_link=True))
async def cmd_start_with_invite(message: Message) -> None:
    """Handle /start command with deep link invite code."""
    if not message.from_user:
        return

    telegram_id = message.from_user.id
    detected_lang = detect_language(message.from_user.language_code)

    # Extract invite code from deep link
    parts = (message.text or "").split(maxsplit=1)
    invite_code = parts[1] if len(parts) > 1 else None

    async with repository.session_factory() as session:
        user = await repository.get_user_by_telegram_id(session, telegram_id)

        # Existing user - show welcome
        if user is not None:
            lang = Language(user.language) if user.language else detected_lang
            await message.answer(get_text("start_welcome", lang), parse_mode="MarkdownV2")
            return

        # Admin without user record - auto-create
        if telegram_id in settings.admin_ids:
            await _create_user_with_language(session, telegram_id, detected_lang)
            await session.commit()
            await _send_welcome_with_lang_select(message, detected_lang)
            return

        # New user with invite code
        if invite_code:
            if not await _validate_and_use_invite(session, invite_code, detected_lang, message):
                return

            await _create_user_with_language(session, telegram_id, detected_lang, invite_code)
            await session.commit()

            prefix = get_text("invite_success", detected_lang) + "\n\n"
            await _send_welcome_with_lang_select(message, detected_lang, prefix)
            return

        # New user without valid code
        await message.answer(get_text("invite_required", detected_lang), parse_mode="MarkdownV2")


@router.message(CommandStart())
async def cmd_start(message: Message) -> None:
    """Handle /start command without deep link."""
    if not message.from_user:
        return

    telegram_id = message.from_user.id
    detected_lang = detect_language(message.from_user.language_code)

    async with repository.session_factory() as session:
        user = await repository.get_user_by_telegram_id(session, telegram_id)

        # Existing user - show welcome
        if user is not None:
            lang = Language(user.language) if user.language else detected_lang
            await message.answer(get_text("start_welcome", lang), parse_mode="MarkdownV2")
            return

        # Admin without user record - auto-create
        if telegram_id in settings.admin_ids:
            await _create_user_with_language(session, telegram_id, detected_lang)
            await session.commit()
            await _send_welcome_with_lang_select(message, detected_lang)
            return

        # New user without invite
        await message.answer(get_text("invite_required", detected_lang), parse_mode="MarkdownV2")


@router.message(Command("help"))
async def cmd_help(message: Message) -> None:
    """Handle /help command."""
    if not message.from_user:
        return

    lang = await get_user_language(message.from_user.id)
    await message.answer(get_text("help_text", lang), parse_mode="MarkdownV2")


@router.message(Command("lang", "language"))
async def cmd_lang(message: Message) -> None:
    """Handle /lang command to change language."""
    if not message.from_user:
        return

    lang = await get_user_language(message.from_user.id)
    await message.answer(
        get_text("lang_select", lang),
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
        await repository.get_or_create_user(session, telegram_id)
        new_value = await repository.toggle_show_thinking(session, telegram_id)
        await session.commit()

    lang = await get_user_language(telegram_id)
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
        user = await repository.get_or_create_user(session, telegram_id)
        conv = await repository.get_or_create_conversation(session, user.id, chat_id, thread_id)

        # Get latest user message
        latest_user_msg = await repository.get_latest_user_message(session, conv.id)
        if not latest_user_msg:
            lang = await get_user_language(telegram_id)
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
            session, conv.id, "assistant", result.content, message_id=result.first_message_id
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
        lang = await get_user_language(message.from_user.id)
        await message.answer(get_text("edit_usage", lang), parse_mode="MarkdownV2")
        return

    await _handle_redo_latest(message, bot, parts[1])


@router.message(Command("code"))
async def cmd_code(message: Message) -> None:
    """Handle /code command to manually enter an invite code."""
    if not message.from_user:
        return

    telegram_id = message.from_user.id
    detected_lang = detect_language(message.from_user.language_code)

    # Parse code argument
    parts = (message.text or "").split(maxsplit=1)
    if len(parts) < 2:
        await message.answer(get_text("code_usage", detected_lang), parse_mode="MarkdownV2")
        return

    invite_code = parts[1].strip()

    async with repository.session_factory() as session:
        user = await repository.get_user_by_telegram_id(session, telegram_id)

        # User already has access
        if user is not None:
            lang = Language(user.language) if user.language else detected_lang
            await message.answer(get_text("code_already_approved", lang), parse_mode="MarkdownV2")
            return

        # Validate and use invite code
        if not await _validate_and_use_invite(session, invite_code, detected_lang, message):
            return

        await _create_user_with_language(session, telegram_id, detected_lang, invite_code)
        await session.commit()

    prefix = get_text("invite_success", detected_lang) + "\n\n"
    await _send_welcome_with_lang_select(message, detected_lang, prefix)


def _format_timezone_offset(offset_minutes: int) -> str:
    """Format timezone offset as UTC+X or UTC-X string."""
    if offset_minutes == 0:
        return "UTC"

    sign = "+" if offset_minutes > 0 else "-"
    abs_minutes = abs(offset_minutes)
    hours = abs_minutes // 60
    minutes = abs_minutes % 60

    if minutes == 0:
        return f"UTC{sign}{hours}"
    return f"UTC{sign}{hours}:{minutes:02d}"


@router.message(Command("timezone"))
async def cmd_timezone(message: Message) -> None:
    """Handle /timezone command to set user's timezone."""
    if not message.from_user:
        return

    telegram_id = message.from_user.id
    lang = await get_user_language(telegram_id)

    # Parse time argument
    parts = (message.text or "").split(maxsplit=1)
    if len(parts) < 2:
        # Show current timezone and usage
        async with repository.session_factory() as session:
            offset = await repository.get_user_timezone(session, telegram_id)

        timezone_str = _format_timezone_offset(offset)
        # Escape special characters for MarkdownV2
        timezone_escaped = timezone_str.replace("-", "\\-").replace("+", "\\+")
        current_msg = get_text("timezone_current", lang, timezone=timezone_escaped)
        usage_msg = get_text("timezone_usage", lang)
        await message.answer(f"{current_msg}\n\n{usage_msg}", parse_mode="MarkdownV2")
        return

    time_arg = parts[1].strip().upper()

    # Parse HH:MM or HH:MM AM/PM format
    try:
        if ":" not in time_arg:
            raise ValueError("Invalid format")

        # Check for AM/PM suffix
        is_pm = "PM" in time_arg
        is_am = "AM" in time_arg
        time_part = time_arg.replace("AM", "").replace("PM", "").strip()

        hour_str, minute_str = time_part.split(":", 1)
        user_hour = int(hour_str)
        user_minute = int(minute_str)

        # Convert 12-hour to 24-hour format
        if is_am or is_pm:
            if not (1 <= user_hour <= 12 and 0 <= user_minute < 60):
                raise ValueError("Invalid time range")
            if is_am:
                user_hour = 0 if user_hour == 12 else user_hour
            else:  # PM
                user_hour = 12 if user_hour == 12 else user_hour + 12
        else:
            if not (0 <= user_hour < 24 and 0 <= user_minute < 60):
                raise ValueError("Invalid time range")
    except ValueError:
        await message.answer(get_text("timezone_invalid", lang), parse_mode="MarkdownV2")
        return

    # Calculate offset from UTC
    now_utc = datetime.now(UTC)
    utc_minutes = now_utc.hour * 60 + now_utc.minute
    user_minutes = user_hour * 60 + user_minute

    # Calculate raw offset
    raw_offset = user_minutes - utc_minutes

    # Handle day boundary (e.g., user at 02:00 when UTC is 23:00)
    if raw_offset > 720:  # More than +12 hours
        raw_offset -= 1440
    elif raw_offset < -720:  # More than -12 hours
        raw_offset += 1440

    # Round to nearest 15 minutes for standard timezone alignment
    offset_minutes = round(raw_offset / 15) * 15

    # Save to database
    async with repository.session_factory() as session:
        await repository.update_user_timezone(session, telegram_id, offset_minutes)
        await session.commit()

    timezone_str = _format_timezone_offset(offset_minutes)
    # Escape special characters for MarkdownV2
    timezone_escaped = timezone_str.replace("-", "\\-").replace("+", "\\+")
    await message.answer(
        get_text("timezone_set", lang, timezone=timezone_escaped),
        parse_mode="MarkdownV2",
    )
