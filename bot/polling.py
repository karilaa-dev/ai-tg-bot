"""Long polling loop for receiving Telegram updates."""

import asyncio
import logging
from typing import Any

from bot.handlers.commands import handle_thinking_command
from bot.handlers.message import handle_message
from bot.handlers.telegram import telegram_client
from bot.database.repository import repository

logger = logging.getLogger(__name__)


async def process_update(update: dict[str, Any]) -> None:
    """Process a single update from Telegram."""
    try:
        message = update.get("message")
        if not message:
            return

        text = message.get("text", "")
        chat_id = message.get("chat", {}).get("id")
        from_user = message.get("from", {})
        telegram_id = from_user.get("id")
        message_thread_id = message.get("message_thread_id")

        if text.startswith("/thinking"):
            async with repository.session_factory() as session:
                await repository.get_or_create_user(
                    session,
                    telegram_id,
                    from_user.get("username"),
                    from_user.get("first_name"),
                )
                await session.commit()

            await handle_thinking_command(
                chat_id, telegram_id, message_thread_id
            )
            return

        if text.startswith("/start"):
            await telegram_client.send_message(
                chat_id=chat_id,
                text="Hello! I'm an AI assistant. Send me a message, image, or PDF and I'll respond.",
                message_thread_id=message_thread_id,
            )
            return

        if text.startswith("/"):
            return

        await handle_message(update)

    except Exception as e:
        logger.exception(f"Error processing update: {e}")


async def start_polling() -> None:
    """Start the long polling loop."""
    logger.info("Starting long polling...")
    offset = 0

    while True:
        try:
            result = await telegram_client.get_updates(
                offset=offset,
                timeout=30,
                allowed_updates=["message"],
            )

            if not result.get("ok"):
                logger.error(f"Failed to get updates: {result}")
                await asyncio.sleep(1)
                continue

            updates = result.get("result", [])

            for update in updates:
                update_id = update.get("update_id", 0)
                offset = update_id + 1

                asyncio.create_task(process_update(update))

        except asyncio.CancelledError:
            logger.info("Polling cancelled")
            break
        except Exception as e:
            logger.exception(f"Polling error: {e}")
            await asyncio.sleep(1)
