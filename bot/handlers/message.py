"""Message handling logic."""

import asyncio
import logging
import time
from typing import Any

from bot.ai.openrouter import openrouter_client
from bot.database.models import Message
from bot.database.repository import repository
from bot.handlers.telegram import telegram_client
from bot.utils import (
    SAFE_MESSAGE_LENGTH,
    download_and_encode_image,
    download_and_encode_pdf,
    escape_markdown_v2_preserve_code,
    format_thinking_block,
    split_message,
    trim_messages_to_limit,
)

logger = logging.getLogger(__name__)


async def _build_content(
    text: str, image_id: str | None, pdf_id: str | None
) -> str | list[dict[str, Any]]:
    """Build OpenRouter message content with optional image/PDF."""
    parts: list[dict[str, Any]] = []

    if text:
        parts.append({"type": "text", "text": text})

    if image_id:
        if data := await download_and_encode_image(image_id, telegram_client):
            parts.append({"type": "image_url", "image_url": {"url": data}})

    if pdf_id:
        if result := await download_and_encode_pdf(pdf_id, telegram_client):
            parts.append({"type": "file", "file": {"filename": result[1], "file_data": result[0]}})

    # Return plain string if only text, otherwise return parts list
    if len(parts) == 1 and parts[0].get("type") == "text":
        return parts[0]["text"]
    return parts


async def _format_history(messages: list[Message]) -> list[dict[str, Any]]:
    """Convert database messages to OpenRouter format."""
    return [
        {"role": m.role, "content": await _build_content(m.content, m.image_file_id, m.pdf_file_id)}
        for m in messages
    ]


async def _send_with_markdown_fallback(
    chat_id: int,
    text: str,
    thread_id: int | None,
    escape: bool = True,
) -> dict[str, Any]:
    """Send message with MarkdownV2, falling back to plain text on parse errors."""
    escaped = escape_markdown_v2_preserve_code(text) if escape else text
    result = await telegram_client.send_message(
        chat_id=chat_id,
        text=escaped,
        message_thread_id=thread_id,
        parse_mode="MarkdownV2",
    )
    if not result.get("ok") and "parse" in result.get("description", "").lower():
        logger.warning("MarkdownV2 failed, using plain text")
        result = await telegram_client.send_message(
            chat_id=chat_id,
            text=text,
            message_thread_id=thread_id,
        )
    return result


def _find_split_point(text: str, max_length: int) -> int:
    """Find a good point to split text, preferring natural boundaries."""
    chunk = text[:max_length]
    for sep in ["\n\n", "\n", ". ", " "]:
        pos = chunk.rfind(sep)
        if pos > max_length // 2:
            return pos + len(sep)
    return max_length


def _generate_draft_id() -> int:
    """Generate a unique draft ID."""
    return int(time.time() * 1000) % (2**31 - 1)


async def handle_message(update: dict[str, Any]) -> None:
    """Handle an incoming message."""
    msg = update.get("message", {})
    chat_id = msg.get("chat", {}).get("id")
    user_data = msg.get("from", {})
    thread_id = msg.get("message_thread_id")

    text = msg.get("text", "") or msg.get("caption", "")
    image_id = msg["photo"][-1]["file_id"] if msg.get("photo") else None
    doc = msg.get("document")
    pdf_id = doc["file_id"] if doc and doc.get("mime_type") == "application/pdf" else None

    if not text and not image_id and not pdf_id:
        return

    # Load user and save incoming message
    async with repository.session_factory() as session:
        user = await repository.get_or_create_user(
            session, user_data.get("id"), user_data.get("username"), user_data.get("first_name")
        )
        conv = await repository.get_or_create_conversation(session, user.id, chat_id, thread_id)
        await repository.add_message(
            session, conv.id, "user", text, msg.get("message_id"), image_id, pdf_id
        )
        db_messages = await repository.get_conversation_messages(session, conv.id)
        show_thinking = user.show_thinking
        await session.commit()

    # Prepare AI messages
    ai_messages = trim_messages_to_limit(await _format_history(db_messages))

    # Stream response
    thinking_draft_id = _generate_draft_id()
    content_draft_id = (thinking_draft_id + 1) % (2**31 - 1)
    content, reasoning = "", ""
    last_update = 0.0
    sent_parts: list[str] = []
    thinking_finalized = False
    in_code_block = False

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
                    sent_parts.append(step_content)  # Track as "sent" so it's not included in final content

                # Add tool use indicator to thinking
                reasoning += f"(Using {chunk.tool_name}...)\n"

            if time.time() - last_update < 0.5:
                continue

            # Stream thinking draft
            if show_thinking and reasoning and not thinking_finalized:
                thinking_preview = format_thinking_block(reasoning)
                if thinking_preview:
                    await telegram_client.send_message_draft(
                        chat_id=chat_id,
                        draft_id=thinking_draft_id,
                        text=thinking_preview[:SAFE_MESSAGE_LENGTH],
                        message_thread_id=thread_id,
                        parse_mode="MarkdownV2",
                    )

            # Stream content draft
            sent_len = sum(len(p) for p in sent_parts)
            preview = content[sent_len:] if content else ""

            # Finalize and send if approaching limit
            if len(preview) >= SAFE_MESSAGE_LENGTH - 100:
                split_point = _find_split_point(preview, SAFE_MESSAGE_LENGTH - 200)
                part = preview[:split_point].rstrip()

                if part:
                    if in_code_block:
                        part = "```\n" + part
                    ends_mid_block = part.count("```") % 2 == 1

                    # Finalize thinking first
                    if show_thinking and reasoning and not thinking_finalized:
                        await _send_with_markdown_fallback(
                            chat_id, format_thinking_block(reasoning), thread_id, escape=False
                        )
                        thinking_finalized = True

                    # Send content part
                    escaped = escape_markdown_v2_preserve_code(part, close_incomplete=ends_mid_block)
                    result = await telegram_client.send_message(
                        chat_id=chat_id,
                        text=escaped,
                        message_thread_id=thread_id,
                        parse_mode="MarkdownV2",
                    )

                    if not result.get("ok"):
                        desc = result.get("description", "")
                        if "parse" in desc.lower():
                            result = await telegram_client.send_message(
                                chat_id=chat_id, text=part, message_thread_id=thread_id
                            )
                        elif "retry_after" in result.get("parameters", {}):
                            await asyncio.sleep(result["parameters"]["retry_after"])
                            result = await telegram_client.send_message(
                                chat_id=chat_id, text=part, message_thread_id=thread_id
                            )

                    if result.get("ok"):
                        in_code_block = ends_mid_block
                        sent_parts.append(part)
                        content_draft_id = _generate_draft_id()

                    last_update = time.time()
                    continue

            # Update content draft
            if preview.strip():
                draft_text = ("```\n" + preview if in_code_block else preview)[:SAFE_MESSAGE_LENGTH]
                escaped = escape_markdown_v2_preserve_code(draft_text, close_incomplete=True)
                result = await telegram_client.send_message_draft(
                    chat_id=chat_id,
                    draft_id=content_draft_id,
                    text=escaped,
                    message_thread_id=thread_id,
                    parse_mode="MarkdownV2",
                )
                if not result.get("ok") and "parse" in result.get("description", "").lower():
                    await telegram_client.send_message_draft(
                        chat_id=chat_id,
                        draft_id=content_draft_id,
                        text=draft_text,
                        message_thread_id=thread_id,
                    )

            last_update = time.time()

    except Exception as e:
        logger.error(f"Error generating response: {e}")
        content = "Sorry, an error occurred."

    # Send final thinking
    if show_thinking and reasoning and not thinking_finalized:
        thinking_msg = format_thinking_block(reasoning)
        if thinking_msg:
            result = await telegram_client.send_message(
                chat_id=chat_id,
                text=thinking_msg,
                message_thread_id=thread_id,
                parse_mode="MarkdownV2",
            )
            if not result.get("ok"):
                await telegram_client.send_message(
                    chat_id=chat_id, text=reasoning, message_thread_id=thread_id
                )
        await asyncio.sleep(0.1)

    # Send remaining content
    final_content = content or "No response generated."
    sent_len = sum(len(p) for p in sent_parts)
    remaining = final_content[sent_len:] if sent_len < len(final_content) else final_content

    if remaining.strip():
        if in_code_block:
            remaining = "```\n" + remaining

        for i, part in enumerate(split_message(remaining)):
            if i > 0 or sent_parts:
                await asyncio.sleep(0.1)
            await _send_with_markdown_fallback(chat_id, part, thread_id)

    # Save assistant response
    async with repository.session_factory() as session:
        conv = await repository.get_or_create_conversation(session, user.id, chat_id, thread_id)
        await repository.add_message(session, conv.id, "assistant", content)
        await session.commit()
