"""Handlers package for aiogram routers."""

from aiogram import Router

from bot.telegram.handlers.callbacks import router as callbacks_router
from bot.telegram.handlers.commands import router as commands_router
from bot.telegram.handlers.messages import router as messages_router

router = Router(name="main")
router.include_router(commands_router)
router.include_router(callbacks_router)
router.include_router(messages_router)

__all__ = ["router"]
