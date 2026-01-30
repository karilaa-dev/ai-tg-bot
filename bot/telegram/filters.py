"""Custom aiogram filters for access control."""

from aiogram.filters import Filter
from aiogram.types import Message

from bot.config import settings
from bot.database.repository import repository


class AdminFilter(Filter):
    """Filter that only allows admin users."""

    async def __call__(self, message: Message) -> bool:
        if not message.from_user:
            return False
        return message.from_user.id in settings.admin_ids


class ApprovedUserFilter(Filter):
    """Filter that allows users in DB or admins."""

    async def __call__(self, message: Message) -> bool:
        if not message.from_user:
            return False

        telegram_id = message.from_user.id

        # Admins always have access
        if telegram_id in settings.admin_ids:
            return True

        # Check if user exists in database
        async with repository.session_factory() as session:
            user = await repository.get_user_by_telegram_id(session, telegram_id)
            return user is not None
