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

    # Delete old message with keyboard
    try:
        await callback.message.delete()
    except TelegramBadRequest as e:
        logger.debug(f"Could not delete language selection message: {e}")

    # Detect what language would have been auto-detected
    detected_lang = detect_language(callback.from_user.language_code)

    # Send confirmation message
    await callback.message.answer(
        get_text("lang_changed", lang),
        parse_mode="MarkdownV2",
    )

    # If user picked a different language than detected default, resend commands info
    if lang != detected_lang:
        await callback.message.answer(
            get_text("start_welcome", lang),
            parse_mode="MarkdownV2",
        )
