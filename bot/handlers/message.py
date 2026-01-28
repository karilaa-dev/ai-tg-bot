"""Message handling logic."""

import asyncio
import logging
import time
from typing import Any

from bot.ai.openrouter import openrouter_client
from bot.database.models import Message
from bot.database.repository import repository
from bot.handlers.telegram import telegram_client
from bot.utils.formatting import (
    SAFE_MESSAGE_LENGTH,
    escape_markdown_v2_preserve_code,
    format_thinking_block,
    split_message,
)
from bot.utils.image import download_and_encode_image
from bot.utils.pdf import download_and_encode_pdf
from bot.utils.tokens import trim_messages_to_limit

logger = logging.getLogger(__name__)


async def build_content(
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

    return parts[0]["text"] if len(parts) == 1 and parts[0].get("type") == "text" else parts


async def format_history(messages: list[Message]) -> list[dict[str, Any]]:
    """Convert database messages to OpenRouter format."""
    return [
        {"role": m.role, "content": await build_content(m.content, m.image_file_id, m.pdf_file_id)}
        for m in messages
    ]


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
    ai_messages = trim_messages_to_limit(await format_history(db_messages))

    # Stream response with separate drafts for thinking and content
    thinking_draft_id = int(time.time() * 1000) % (2**31 - 1)
    content_draft_id = (thinking_draft_id + 1) % (2**31 - 1)
    content, reasoning = "", ""
    last_update = 0.0
    sent_content_parts: list[str] = []  # Already-finalized content parts
    thinking_finalized = False
    continuing_code_block = False  # Track if next part starts mid-code-block

    try:
        async for chunk in openrouter_client.generate_response_stream(ai_messages, show_thinking):
            reasoning += chunk.reasoning
            content += chunk.content
            if chunk.is_tool_use:
                content += f"\n[Using {chunk.tool_name}...]\n"

            if time.time() - last_update >= 0.5:
                # Stream thinking in separate draft (expandable blockquote format)
                if show_thinking and reasoning and not thinking_finalized:
                    thinking_preview = format_thinking_block(reasoning)
                    if thinking_preview:
                        await telegram_client.send_message_draft(
                            chat_id=chat_id, draft_id=thinking_draft_id,
                            text=thinking_preview[:SAFE_MESSAGE_LENGTH],
                            message_thread_id=thread_id, parse_mode="MarkdownV2"
                        )

                # Stream content in separate draft
                already_sent_len = sum(len(p) for p in sent_content_parts)
                content_preview = content[already_sent_len:] if content else ""

                # Check if content needs to be split
                if len(content_preview) >= SAFE_MESSAGE_LENGTH - 100:
                    split_point = SAFE_MESSAGE_LENGTH - 200
                    for sep in ["\n\n", "\n", ". ", " "]:
                        pos = content_preview[:split_point].rfind(sep)
                        if pos > split_point // 2:
                            split_point = pos + len(sep)
                            break

                    part_to_send = content_preview[:split_point].rstrip()
                    if part_to_send:
                        # If continuing from previous mid-code-block, prepend opening marker
                        if continuing_code_block:
                            part_to_send = "```\n" + part_to_send

                        # Check if this part ends mid-code-block (odd number of ```)
                        ends_mid_block = part_to_send.count("```") % 2 == 1

                        # Finalize thinking first if not done
                        if show_thinking and reasoning and not thinking_finalized:
                            thinking_msg = format_thinking_block(reasoning)
                            await telegram_client.send_message(
                                chat_id=chat_id, text=thinking_msg,
                                message_thread_id=thread_id, parse_mode="MarkdownV2"
                            )
                            thinking_finalized = True

                        # Send content part with fallback to plain text
                        escaped_part = escape_markdown_v2_preserve_code(
                            part_to_send, close_incomplete=ends_mid_block
                        )
                        result = await telegram_client.send_message(
                            chat_id=chat_id, text=escaped_part,
                            message_thread_id=thread_id, parse_mode="MarkdownV2"
                        )
                        if not result.get("ok"):
                            error_desc = result.get("description", "")
                            if "parse" in error_desc.lower():
                                logger.warning("Finalized MarkdownV2 failed, using plain text")
                                result = await telegram_client.send_message(
                                    chat_id=chat_id, text=part_to_send,
                                    message_thread_id=thread_id
                                )
                            elif "retry_after" in result.get("parameters", {}):
                                # Rate limited - wait and retry
                                wait_time = result["parameters"]["retry_after"]
                                logger.warning(f"Rate limited, waiting {wait_time}s")
                                await asyncio.sleep(wait_time)
                                result = await telegram_client.send_message(
                                    chat_id=chat_id, text=part_to_send,
                                    message_thread_id=thread_id
                                )

                        if result.get("ok"):
                            # Track state for next split
                            continuing_code_block = ends_mid_block
                            sent_content_parts.append(part_to_send)
                            content_draft_id = int(time.time() * 1000) % (2**31 - 1)
                            content_preview = content_preview[split_point:].lstrip()
                        # Skip draft this cycle to avoid rate limiting after finalize
                        last_update = time.time()
                        continue

                if content_preview.strip():
                    # Try MarkdownV2 for drafts to avoid display glitch on final message
                    # Fall back to plain text on parse errors, skip on rate limit
                    truncated_preview = content_preview[:SAFE_MESSAGE_LENGTH]
                    # If continuing from previous mid-code-block, prepend opening marker
                    if continuing_code_block:
                        truncated_preview = "```\n" + truncated_preview
                    escaped_preview = escape_markdown_v2_preserve_code(
                        truncated_preview, close_incomplete=True
                    )
                    result = await telegram_client.send_message_draft(
                        chat_id=chat_id, draft_id=content_draft_id,
                        text=escaped_preview,
                        message_thread_id=thread_id, parse_mode="MarkdownV2"
                    )
                    if not result.get("ok"):
                        error_desc = result.get("description", "")
                        if "retry_after" in result.get("parameters", {}):
                            # Rate limited - skip this draft, will retry next cycle
                            logger.debug("Draft rate limited, skipping")
                        elif "parse" in error_desc.lower():
                            # Parse error - fall back to plain text
                            logger.debug(f"Draft MarkdownV2 failed, using plain text")
                            await telegram_client.send_message_draft(
                                chat_id=chat_id, draft_id=content_draft_id,
                                text=truncated_preview,
                                message_thread_id=thread_id
                            )

                last_update = time.time()
    except Exception as e:
        logger.error(f"Error generating response: {e}")
        content = "Sorry, an error occurred."

    # Send final thinking message if not already sent
    if show_thinking and reasoning and not thinking_finalized:
        thinking_msg = format_thinking_block(reasoning)
        if thinking_msg:
            result = await telegram_client.send_message(
                chat_id=chat_id, text=thinking_msg,
                message_thread_id=thread_id, parse_mode="MarkdownV2"
            )
            if not result.get("ok"):
                logger.warning("Thinking MarkdownV2 failed, using plain text")
                await telegram_client.send_message(
                    chat_id=chat_id, text=reasoning,
                    message_thread_id=thread_id
                )
        await asyncio.sleep(0.1)

    # Send remaining content
    final_content = content or "No response generated."
    already_sent_len = sum(len(p) for p in sent_content_parts)
    remaining = final_content[already_sent_len:] if already_sent_len < len(final_content) else final_content

    if remaining.strip():
        # If continuing from previous mid-code-block, prepend opening marker
        if continuing_code_block:
            remaining = "```\n" + remaining

        # Split first, then escape each part
        parts = split_message(remaining)

        for i, part in enumerate(parts):
            if i > 0 or sent_content_parts:
                await asyncio.sleep(0.1)

            # Try MarkdownV2 with escaped text
            escaped_part = escape_markdown_v2_preserve_code(part)
            result = await telegram_client.send_message(
                chat_id=chat_id, text=escaped_part,
                message_thread_id=thread_id, parse_mode="MarkdownV2"
            )
            if not result.get("ok") and "parse" in result.get("description", "").lower():
                logger.warning("MarkdownV2 failed, using plain text")
                await telegram_client.send_message(
                    chat_id=chat_id, text=part,
                    message_thread_id=thread_id
                )

    # Save assistant response
    async with repository.session_factory() as session:
        conv = await repository.get_or_create_conversation(session, user.id, chat_id, thread_id)
        await repository.add_message(session, conv.id, "assistant", content)
        await session.commit()
