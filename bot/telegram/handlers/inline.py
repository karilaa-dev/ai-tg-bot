"""Inline query handlers for sharing invite codes."""

import random
import string

from aiogram import Router
from aiogram.types import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    InlineQuery,
    InlineQueryResultArticle,
    InputTextMessageContent,
)

from bot.config import settings
from bot.database.repository import repository
from bot.i18n import Language, get_text
from bot.telegram.bot import bot

router = Router(name="inline")

LANG_NAMES = {
    Language.EN: "🇬🇧 English",
    Language.RU: "🇷🇺 Русский",
    Language.UK: "🇺🇦 Українська",
}


def _generate_invite_code() -> str:
    """Generate a random alphanumeric invite code."""
    chars = string.ascii_lowercase + string.digits
    return "".join(random.choices(chars, k=8))


async def _get_or_create_custom_code(code: str, created_by: int) -> str:
    """Get or create a custom invite code, adding uses if exhausted."""
    async with repository.session_factory() as session:
        existing = await repository.get_invite_code(session, code)
        if existing:
            # Check if exhausted
            if existing.max_uses is not None and existing.current_uses >= existing.max_uses:
                # Add +1 to max_uses
                await repository.add_invite_uses(session, code, 1)
                await session.commit()
        else:
            # Create new code with max_uses=1
            await repository.create_invite_code(session, code, created_by, max_uses=1)
            await session.commit()
    return code


@router.inline_query()
async def handle_inline_query(inline_query: InlineQuery) -> None:
    """Handle inline queries for sharing invite codes."""
    if not inline_query.from_user:
        return

    telegram_id = inline_query.from_user.id

    # Only admins can use inline mode
    if telegram_id not in settings.admin_ids:
        await inline_query.answer([], cache_time=60)
        return

    # Get bot info
    bot_info = await bot.get_me()
    bot_username = bot_info.username
    bot_name = bot_info.first_name or "AI Bot"

    # Check for custom code in query
    custom_code = inline_query.query.strip() if inline_query.query else None

    results: list[InlineQueryResultArticle] = []
    languages = [Language.EN, Language.RU, Language.UK]

    if custom_code:
        # Use custom code for all languages
        code = await _get_or_create_custom_code(custom_code, telegram_id)
        for lang in languages:
            result_id = f"{code}_{lang.value}"
            title = get_text("inline_new_invite_title", lang, lang_name=LANG_NAMES[lang])
            description = get_text("inline_new_invite_desc", lang)
            invite_message = get_text(
                "invite_share_message", lang, bot_name=bot_name, code=code
            )
            keyboard = InlineKeyboardMarkup(
                inline_keyboard=[
                    [
                        InlineKeyboardButton(
                            text=get_text("inline_join_button", lang),
                            url=f"https://t.me/{bot_username}?text=/code {code}",
                        )
                    ]
                ]
            )
            results.append(
                InlineQueryResultArticle(
                    id=result_id,
                    title=title,
                    description=description,
                    input_message_content=InputTextMessageContent(
                        message_text=invite_message,
                        parse_mode="MarkdownV2",
                    ),
                    reply_markup=keyboard,
                )
            )
    else:
        # Generate random codes for each language
        for lang in languages:
            code = _generate_invite_code()

            async with repository.session_factory() as session:
                existing = await repository.get_invite_code(session, code)
                if not existing:
                    await repository.create_invite_code(session, code, telegram_id, max_uses=1)
                    await session.commit()

            result_id = f"{code}_{lang.value}"
            title = get_text("inline_new_invite_title", lang, lang_name=LANG_NAMES[lang])
            description = get_text("inline_new_invite_desc", lang)
            invite_message = get_text(
                "invite_share_message", lang, bot_name=bot_name, code=code
            )
            keyboard = InlineKeyboardMarkup(
                inline_keyboard=[
                    [
                        InlineKeyboardButton(
                            text=get_text("inline_join_button", lang),
                            url=f"https://t.me/{bot_username}?text=/code {code}",
                        )
                    ]
                ]
            )
            results.append(
                InlineQueryResultArticle(
                    id=result_id,
                    title=title,
                    description=description,
                    input_message_content=InputTextMessageContent(
                        message_text=invite_message,
                        parse_mode="MarkdownV2",
                    ),
                    reply_markup=keyboard,
                )
            )

    await inline_query.answer(results, cache_time=0, is_personal=True)
