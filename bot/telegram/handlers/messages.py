"""Message handling logic for aiogram."""

import asyncio
import logging
import time
from typing import Any

from aiogram import Bot, F, Router
from aiogram.exceptions import TelegramBadRequest, TelegramRetryAfter
from aiogram.types import Message

from bot.ai.openrouter import openrouter_client
from bot.database.models import Message as DbMessage
from bot.database.repository import repository
from bot.telegram.files import download_and_encode_image, download_and_encode_pdf
from bot.utils import (
    SAFE_MESSAGE_LENGTH,
    convert_to_telegram_markdown,
    find_split_point,
    format_thinking_block,
    split_message,
    trim_messages_to_limit,
)

logger = logging.getLogger(__name__)

router = Router(name="messages")


def _generate_draft_id() -> int:
    """Generate a unique draft ID."""
    return int(time.time() * 1000) % (2**31 - 1)


async def _build_content(
    text: str, image_id: str | None, pdf_id: str | None, bot: Bot
) -> str | list[dict[str, Any]]:
    """Build OpenRouter message content with optional image/PDF."""
    parts: list[dict[str, Any]] = []

    if text:
        parts.append({"type": "text", "text": text})

    if image_id:
        if data := await download_and_encode_image(image_id, bot):
            parts.append({"type": "image_url", "image_url": {"url": data}})

    if pdf_id:
        if result := await download_and_encode_pdf(pdf_id, bot):
            parts.append({"type": "file", "file": {"filename": result[1], "file_data": result[0]}})

    # Return plain string if only text, otherwise return parts list
    if len(parts) == 1 and parts[0].get("type") == "text":
        return parts[0]["text"]
    return parts


async def _format_history(messages: list[DbMessage], bot: Bot) -> list[dict[str, Any]]:
    """Convert database messages to OpenRouter format."""
    return [
        {"role": m.role, "content": await _build_content(m.content, m.image_file_id, m.pdf_file_id, bot)}
        for m in messages
    ]


async def _send_with_markdown_fallback(
    bot: Bot,
    chat_id: int,
    text: str,
    thread_id: int | None,
    convert: bool = True,
) -> Message:
    """Send message with MarkdownV2, falling back to plain text on parse errors."""
    formatted = convert_to_telegram_markdown(text) if convert else text
    try:
        return await bot.send_message(
            chat_id=chat_id,
            text=formatted,
            message_thread_id=thread_id,
            parse_mode="MarkdownV2",
        )
    except TelegramBadRequest as e:
        if "parse" in str(e).lower():
            logger.warning("MarkdownV2 failed, using plain text")
            return await bot.send_message(
                chat_id=chat_id,
                text=text,
                message_thread_id=thread_id,
                parse_mode=None,
            )
        raise


async def _send_draft_with_fallback(
    bot: Bot,
    chat_id: int,
    draft_id: int,
    text: str,
    thread_id: int | None,
    formatted: str | None = None,
) -> None:
    """Send draft message with MarkdownV2, falling back to plain text on parse errors."""
    try:
        await bot.send_message_draft(
            chat_id=chat_id,
            draft_id=draft_id,
            text=formatted or text,
            message_thread_id=thread_id,
            parse_mode="MarkdownV2",
        )
    except TelegramBadRequest as e:
        if "parse" in str(e).lower():
            await bot.send_message_draft(
                chat_id=chat_id,
                draft_id=draft_id,
                text=text,
                message_thread_id=thread_id,
                parse_mode=None,
            )


@router.message(F.text & ~F.text.startswith("/") | F.photo | F.document)
async def handle_message(message: Message, bot: Bot) -> None:
    """Handle an incoming message."""
    if not message.from_user:
        return

    chat_id = message.chat.id
    user_data = message.from_user
    thread_id = message.message_thread_id

    text = message.text or message.caption or ""
    image_id = message.photo[-1].file_id if message.photo else None
    doc = message.document
    pdf_id = doc.file_id if doc and doc.mime_type == "application/pdf" else None

    if not text and not image_id and not pdf_id:
        return

    # Load user and save incoming message
    async with repository.session_factory() as session:
        user = await repository.get_or_create_user(
            session, user_data.id, user_data.username, user_data.first_name
        )
        conv = await repository.get_or_create_conversation(session, user.id, chat_id, thread_id)
        await repository.add_message(
            session, conv.id, "user", text, message.message_id, image_id, pdf_id
        )
        db_messages = await repository.get_conversation_messages(session, conv.id)
        show_thinking = user.show_thinking
        await session.commit()

    # Prepare AI messages
    ai_messages = trim_messages_to_limit(await _format_history(db_messages, bot))

    # Send thinking indicator
    await bot.send_chat_action(chat_id, "typing", message_thread_id=thread_id)
    thinking_msg = await bot.send_message(
        chat_id, "Thinking\\.\\.\\.", message_thread_id=thread_id
    )
    thinking_message_id = thinking_msg.message_id

    # Stream response
    thinking_draft_id = _generate_draft_id()
    content_draft_id = (thinking_draft_id + 1) % (2**31 - 1)
    content, reasoning = "", ""
    last_update = 0.0
    sent_parts: list[str] = []
    thinking_finalized = False
    in_code_block = False
    thinking_msg_replaced = False

    try:
        async for chunk in openrouter_client.generate_response_stream(ai_messages, show_thinking):
            reasoning += chunk.reasoning
            content += chunk.content
            if chunk.is_tool_use:
                # Move accumulated content to thinking (tool planning steps)
                sent_len = sum(len(p) for p in sent_parts)
                step_content = content[sent_len:]
                if step_content.strip():
                    reasoning += f"\n{step_content.strip()}\n"
                    sent_parts.append(step_content)

                # Add tool use indicator to thinking
                reasoning += f"(Using {chunk.tool_name}...)\n"

            if time.time() - last_update < 0.5:
                continue

            # Stream thinking draft
            if show_thinking and reasoning and not thinking_finalized:
                thinking_preview = format_thinking_block(reasoning)
                if thinking_preview:
                    await _send_draft_with_fallback(
                        bot,
                        chat_id,
                        thinking_draft_id,
                        thinking_preview[:SAFE_MESSAGE_LENGTH],
                        thread_id,
                        thinking_preview[:SAFE_MESSAGE_LENGTH],
                    )

            # Stream content draft
            sent_len = sum(len(p) for p in sent_parts)
            preview = content[sent_len:] if content else ""

            # Finalize and send if approaching limit
            if len(preview) >= SAFE_MESSAGE_LENGTH - 100:
                split_point = find_split_point(preview, SAFE_MESSAGE_LENGTH - 200)
                part = preview[:split_point].rstrip()

                if part:
                    if in_code_block:
                        part = "```\n" + part
                    ends_mid_block = part.count("```") % 2 == 1

                    # Finalize thinking first
                    if show_thinking and reasoning and not thinking_finalized:
                        await _send_with_markdown_fallback(
                            bot, chat_id, format_thinking_block(reasoning), thread_id, convert=False
                        )
                        thinking_finalized = True

                    # Delete thinking message if not yet done
                    if not thinking_msg_replaced and thinking_message_id:
                        try:
                            await bot.delete_message(chat_id, thinking_message_id)
                        except TelegramBadRequest:
                            pass
                        thinking_msg_replaced = True

                    # Send content part
                    formatted = convert_to_telegram_markdown(part)
                    try:
                        await bot.send_message(
                            chat_id=chat_id,
                            text=formatted,
                            message_thread_id=thread_id,
                            parse_mode="MarkdownV2",
                        )
                        in_code_block = ends_mid_block
                        sent_parts.append(part)
                        content_draft_id = _generate_draft_id()
                    except TelegramBadRequest as e:
                        if "parse" in str(e).lower():
                            await bot.send_message(
                                chat_id=chat_id,
                                text=part,
                                message_thread_id=thread_id,
                                parse_mode=None,
                            )
                            in_code_block = ends_mid_block
                            sent_parts.append(part)
                            content_draft_id = _generate_draft_id()
                    except TelegramRetryAfter as e:
                        await asyncio.sleep(e.retry_after)
                        await bot.send_message(
                            chat_id=chat_id,
                            text=part,
                            message_thread_id=thread_id,
                            parse_mode=None,
                        )
                        in_code_block = ends_mid_block
                        sent_parts.append(part)
                        content_draft_id = _generate_draft_id()

                    last_update = time.time()
                    continue

            # Update content draft
            if preview.strip():
                # Delete the "Thinking..." message when first content arrives
                if not thinking_msg_replaced and thinking_message_id:
                    try:
                        await bot.delete_message(chat_id, thinking_message_id)
                    except TelegramBadRequest:
                        pass
                    thinking_msg_replaced = True

                draft_text = ("```\n" + preview if in_code_block else preview)[:SAFE_MESSAGE_LENGTH]
                formatted = convert_to_telegram_markdown(draft_text)
                await _send_draft_with_fallback(
                    bot, chat_id, content_draft_id, draft_text, thread_id, formatted
                )

            last_update = time.time()

    except Exception as e:
        logger.error(f"Error generating response: {e}")
        content = "Sorry, an error occurred."

    # Send final thinking
    if show_thinking and reasoning and not thinking_finalized:
        thinking_text = format_thinking_block(reasoning)
        if thinking_text:
            await _send_with_markdown_fallback(bot, chat_id, thinking_text, thread_id, convert=False)
            await asyncio.sleep(0.1)

    # Send remaining content
    final_content = content or "No response generated."
    sent_len = sum(len(p) for p in sent_parts)
    remaining = final_content[sent_len:] if sent_len < len(final_content) else final_content

    if remaining.strip():
        if in_code_block:
            remaining = "```\n" + remaining

        # Delete thinking message if not yet done
        if not thinking_msg_replaced and thinking_message_id:
            try:
                await bot.delete_message(chat_id, thinking_message_id)
            except TelegramBadRequest:
                pass
            thinking_msg_replaced = True

        for i, part in enumerate(split_message(remaining)):
            if i > 0 or sent_parts:
                await asyncio.sleep(0.1)
            await _send_with_markdown_fallback(bot, chat_id, part, thread_id)

    # Delete thinking message if it somehow wasn't deleted yet
    if not thinking_msg_replaced and thinking_message_id:
        try:
            await bot.delete_message(chat_id, thinking_message_id)
        except TelegramBadRequest:
            pass

    # Save assistant response
    async with repository.session_factory() as session:
        conv = await repository.get_or_create_conversation(session, user.id, chat_id, thread_id)
        await repository.add_message(session, conv.id, "assistant", content)
        await session.commit()
