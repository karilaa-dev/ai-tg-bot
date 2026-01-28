"""Telegram bot module using aiogram."""

from bot.telegram.bot import bot, dp
from bot.telegram.handlers import router

dp.include_router(router)

__all__ = ["bot", "dp", "router"]
