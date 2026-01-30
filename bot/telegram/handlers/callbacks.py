"""Callback query handlers for inline keyboards."""

import logging

from aiogram import F, Router
from aiogram.exceptions import TelegramBadRequest
from aiogram.types import CallbackQuery

from bot.database.repository import repository
from bot.i18n import Language, detect_language, get_text

logger = logging.getLogger(__name__)

router = Router(name="callbacks")


@router.callback_query(F.data.startswith("lang:"))
async def handle_language_selection(callback: CallbackQuery) -> None:
    """Handle language selection callback."""
    if not callback.data or not callback.from_user or not callback.message:
        return

    lang_code = callback.data.split(":")[1]

    try:
        lang = Language(lang_code)
    except ValueError:
        await callback.answer("Invalid language")
        return

    telegram_id = callback.from_user.id

    async with repository.session_factory() as session:
        await repository.get_or_create_user(
            session,
            telegram_id,
            callback.from_user.username,
            callback.from_user.first_name,
        )
        await repository.update_user_language(session, telegram_id, lang.value)
        await session.commit()

    await callback.answer()

    # Detect what language would have been auto-detected
    detected_lang = detect_language(callback.from_user.language_code)

    # Build confirmation message
    confirmation = get_text("lang_changed", lang)
    if lang != detected_lang:
        # If user picked a different language, include welcome info
        confirmation = f"{confirmation}\n\n{get_text('start_welcome', lang)}"

    # Edit the message in-place instead of delete+send
    try:
        await callback.message.edit_text(
            confirmation,
            parse_mode="MarkdownV2",
            reply_markup=None,
        )
    except TelegramBadRequest as e:
        logger.debug(f"Could not edit language selection message: {e}")
        # Fallback to sending new message if edit fails
        await callback.message.answer(confirmation, parse_mode="MarkdownV2")
