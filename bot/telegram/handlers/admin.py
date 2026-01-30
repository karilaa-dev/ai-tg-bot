"""Admin command handlers for the Telegram bot."""

import random
import string

from aiogram import Router
from aiogram.filters import Command
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, Message

from bot.config import settings
from bot.database.repository import repository
from bot.i18n import Language, get_text
from bot.telegram.bot import bot
from bot.telegram.filters import AdminFilter

router = Router(name="admin")
router.message.filter(AdminFilter())


async def _get_admin_lang(telegram_id: int) -> Language:
    """Get admin's language preference."""
    async with repository.session_factory() as session:
        lang_code = await repository.get_user_language(session, telegram_id)
    try:
        return Language(lang_code)
    except ValueError:
        return Language.EN


def _generate_invite_code() -> str:
    """Generate a random alphanumeric invite code."""
    chars = string.ascii_lowercase + string.digits
    return "".join(random.choices(chars, k=8))


async def _build_invite_message_async(code: str, lang: Language) -> tuple[str, InlineKeyboardMarkup]:
    """Build invite message and keyboard."""
    info = await bot.get_me()
    bot_name = info.first_name or "AI Bot"

    message = get_text("invite_share_message", lang, bot_name=bot_name, code=code)

    # Use ?text= format to pre-fill the /code command (works with topics)
    keyboard = InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text=get_text("inline_join_button", lang),
                    url=f"https://t.me/{info.username}?text=/code {code}",
                )
            ]
        ]
    )

    return message, keyboard


@router.message(Command("invite"))
async def cmd_invite(message: Message) -> None:
    """Handle /invite command to create invite codes.

    Usage:
    - /invite - random code, unlimited uses
    - /invite mycode - custom code "mycode", unlimited uses
    - /invite mycode 5 - custom code, 5 uses max
    - /invite 5 - random code, 5 uses max
    """
    if not message.from_user:
        return

    telegram_id = message.from_user.id
    lang = await _get_admin_lang(telegram_id)

    # Parse arguments
    text = message.text or ""
    parts = text.split()[1:]  # Remove /invite

    code: str | None = None
    max_uses: int | None = None

    if len(parts) == 0:
        # /invite - random code, 1 use (default)
        code = _generate_invite_code()
        max_uses = 1
    elif len(parts) == 1:
        # Could be /invite mycode or /invite 5
        if parts[0].isdigit():
            # /invite 5 - random code, 5 uses
            code = _generate_invite_code()
            max_uses = int(parts[0])
        else:
            # /invite mycode - custom code, 1 use (default)
            code = parts[0]
            max_uses = 1
    elif len(parts) >= 2:
        # /invite mycode 5
        code = parts[0]
        if parts[1].isdigit():
            max_uses = int(parts[1])
        else:
            max_uses = 1

    async with repository.session_factory() as session:
        # Check if code already exists
        existing = await repository.get_invite_code(session, code)
        if existing:
            await message.answer(
                get_text("invite_code_exists", lang), parse_mode="MarkdownV2"
            )
            return

        await repository.create_invite_code(session, code, telegram_id, max_uses)
        await session.commit()

    # Build response - first show admin confirmation, then the shareable invite
    if max_uses:
        admin_response = get_text("invite_created_with_limit", lang, code=code, max_uses=str(max_uses))
    else:
        admin_response = get_text("invite_created", lang, code=code)

    await message.answer(admin_response, parse_mode="MarkdownV2")

    # Send the shareable invite message
    invite_msg, keyboard = await _build_invite_message_async(code, lang)
    await message.answer(invite_msg, parse_mode="MarkdownV2", reply_markup=keyboard)


@router.message(Command("invites"))
async def cmd_invites(message: Message) -> None:
    """Handle /invites command to list all active codes."""
    if not message.from_user:
        return

    telegram_id = message.from_user.id
    lang = await _get_admin_lang(telegram_id)

    async with repository.session_factory() as session:
        codes = await repository.get_all_invite_codes(session)

    if not codes:
        await message.answer(
            get_text("invite_list_empty", lang), parse_mode="MarkdownV2"
        )
        return

    lines = [get_text("invite_list_header", lang)]
    for invite in codes:
        if invite.max_uses is not None:
            lines.append(
                get_text(
                    "invite_list_item_limited",
                    lang,
                    code=invite.code,
                    current=str(invite.current_uses),
                    max=str(invite.max_uses),
                )
            )
        else:
            lines.append(
                get_text("invite_list_item", lang, code=invite.code, uses=str(invite.current_uses))
            )

    await message.answer("\n".join(lines), parse_mode="MarkdownV2")


@router.message(Command("deleteinvite"))
async def cmd_deleteinvite(message: Message) -> None:
    """Handle /deleteinvite command to soft-delete an invite code."""
    if not message.from_user:
        return

    telegram_id = message.from_user.id
    lang = await _get_admin_lang(telegram_id)

    # Parse code argument
    text = message.text or ""
    parts = text.split(maxsplit=1)
    if len(parts) < 2:
        await message.answer(get_text("deleteinvite_usage", lang), parse_mode="MarkdownV2")
        return

    code = parts[1].strip()

    async with repository.session_factory() as session:
        deleted = await repository.delete_invite_code(session, code)
        await session.commit()

    if deleted:
        await message.answer(
            get_text("invite_deleted", lang, code=code), parse_mode="MarkdownV2"
        )
    else:
        await message.answer(
            get_text("invite_not_found", lang), parse_mode="MarkdownV2"
        )


@router.message(Command("approve"))
async def cmd_approve(message: Message) -> None:
    """Handle /approve command to pre-approve user by telegram ID."""
    if not message.from_user:
        return

    telegram_id = message.from_user.id
    lang = await _get_admin_lang(telegram_id)

    # Parse user_id argument
    text = message.text or ""
    parts = text.split(maxsplit=1)
    if len(parts) < 2:
        await message.answer(get_text("approve_usage", lang), parse_mode="MarkdownV2")
        return

    try:
        target_user_id = int(parts[1].strip())
    except ValueError:
        await message.answer(get_text("approve_usage", lang), parse_mode="MarkdownV2")
        return

    async with repository.session_factory() as session:
        existing = await repository.get_user_by_telegram_id(session, target_user_id)
        if existing:
            await message.answer(
                get_text("user_already_approved", lang, user_id=str(target_user_id)),
                parse_mode="MarkdownV2",
            )
            return

        await repository.create_user_by_id(session, target_user_id)
        await session.commit()

    await message.answer(
        get_text("user_approved", lang, user_id=str(target_user_id)),
        parse_mode="MarkdownV2",
    )
