"""Inline query handlers for sharing invite codes."""

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
from bot.utils import generate_invite_code

router = Router(name="inline")

LANG_NAMES = {
    Language.EN: "🇬🇧 English",
    Language.RU: "🇷🇺 Русский",
    Language.UK: "🇺🇦 Українська",
}


async def _get_or_create_custom_code(code: str, created_by: int) -> str:
    """Get or create a custom invite code, adding uses if exhausted."""
    async with repository.session_factory() as session:
        existing = await repository.get_invite_code(session, code)
        if existing:
            if existing.max_uses is not None and existing.current_uses >= existing.max_uses:
                await repository.add_invite_uses(session, code, 1)
                await session.commit()
        else:
            await repository.create_invite_code(session, code, created_by, max_uses=1)
            await session.commit()
    return code


async def _create_random_code(created_by: int) -> str:
    """Generate and store a random invite code."""
    code = generate_invite_code()
    async with repository.session_factory() as session:
        existing = await repository.get_invite_code(session, code)
        if not existing:
            await repository.create_invite_code(session, code, created_by, max_uses=1)
            await session.commit()
    return code


def _build_invite_result(
    code: str, lang: Language, bot_username: str, bot_name: str
) -> InlineQueryResultArticle:
    """Build an inline query result for an invite code."""
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

    return InlineQueryResultArticle(
        id=f"{code}_{lang.value}",
        title=get_text("inline_new_invite_title", lang, lang_name=LANG_NAMES[lang]),
        description=get_text("inline_new_invite_desc", lang),
        input_message_content=InputTextMessageContent(
            message_text=get_text("invite_share_message", lang, bot_name=bot_name, code=code),
            parse_mode="MarkdownV2",
        ),
        reply_markup=keyboard,
    )


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

    bot_info = await bot.get_me()
    bot_username = bot_info.username
    bot_name = bot_info.first_name or "AI Bot"

    custom_code = inline_query.query.strip() if inline_query.query else None
    languages = [Language.EN, Language.RU, Language.UK]

    results: list[InlineQueryResultArticle] = []

    if custom_code:
        code = await _get_or_create_custom_code(custom_code, telegram_id)
        for lang in languages:
            results.append(_build_invite_result(code, lang, bot_username, bot_name))
    else:
        for lang in languages:
            code = await _create_random_code(telegram_id)
            results.append(_build_invite_result(code, lang, bot_username, bot_name))

    await inline_query.answer(results, cache_time=0, is_personal=True)
