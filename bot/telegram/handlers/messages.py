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
    format_thinking_collapsed,
    format_thinking_expanded,
    format_thinking_with_content,
    generate_draft_id,
    split_message,
    split_thinking,
    trim_messages_to_limit,
)

logger = logging.getLogger(__name__)

router = Router(name="messages")


def _get_tool_status_text(tool_name: str) -> str:
    """Get user-friendly status text for a tool."""
    tool_display_map = {
        "web_search": "Searching web\\.\\.\\.",
        "extract_webpage": "Reading webpage\\.\\.\\.",
    }
    return tool_display_map.get(tool_name, f"Using {tool_name}\\.\\.\\.")


# Minimum characters to confirm final response (tool planning is typically shorter)
FINAL_CONTENT_MIN_LENGTH = 100


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

    # Send thinking indicator (only when not showing thinking blocks)
    await bot.send_chat_action(chat_id, "typing", message_thread_id=thread_id)

    # Use a unified draft for all streaming (both show_thinking modes)
    unified_draft_id = generate_draft_id()

    # Stream response
    content, reasoning = "", ""
    last_update = 0.0
    sent_parts: list[str] = []  # Content parts already sent as permanent messages
    sent_thinking_parts: list[str] = []  # Thinking parts sent as permanent (overflow)
    thinking_finalized = False
    in_code_block = False
    thinking_msg_replaced = False
    pending_tool: str | None = None
    current_status_text = "Thinking\\.\\.\\."
    final_content_confirmed = False

    try:
        # Send initial "Thinking..." as draft
        await _send_draft_with_fallback(
            bot, chat_id, unified_draft_id, "Thinking\\.\\.\\.", thread_id
        )

        async for chunk in openrouter_client.generate_response_stream(ai_messages, show_thinking):
            # Prepend tool indicator when new thinking arrives after tool use
            if chunk.reasoning and pending_tool:
                reasoning += f"(Used {pending_tool})\n"
                pending_tool = None
                # Restore "Thinking..." status after tool completes (non-thinking mode)
                if not show_thinking and not thinking_msg_replaced:
                    if current_status_text != "Thinking\\.\\.\\.":
                        await _send_draft_with_fallback(
                            bot, chat_id, unified_draft_id, "Thinking\\.\\.\\.", thread_id
                        )
                        current_status_text = "Thinking\\.\\.\\."

            reasoning += chunk.reasoning
            content += chunk.content

            if chunk.is_tool_use:
                # Move accumulated content to thinking (tool planning steps)
                sent_len = sum(len(p) for p in sent_parts)
                step_content = content[sent_len:]
                if step_content.strip():
                    reasoning += f"\n{step_content.strip()}\n"
                    sent_parts.append(step_content)
                pending_tool = chunk.tool_name
                final_content_confirmed = False  # Reset - this content was pre-tool
                thinking_msg_replaced = False  # Reset - draft should show tool status now
                # Update draft to show tool status
                new_text = _get_tool_status_text(chunk.tool_name)
                if show_thinking and reasoning:
                    # Append tool status to expanded thinking
                    sent_thinking_len = sum(len(p) for p in sent_thinking_parts)
                    current_thinking = reasoning[sent_thinking_len:]
                    if current_thinking:
                        thinking_with_status = format_thinking_expanded(
                            current_thinking + f"\n{new_text.replace('\\\\', '').replace('\\.', '.')}"
                        )
                        await _send_draft_with_fallback(
                            bot, chat_id, unified_draft_id, thinking_with_status, thread_id, thinking_with_status
                        )
                    else:
                        await _send_draft_with_fallback(
                            bot, chat_id, unified_draft_id, new_text, thread_id
                        )
                else:
                    await _send_draft_with_fallback(
                        bot, chat_id, unified_draft_id, new_text, thread_id
                    )
                current_status_text = new_text

            if time.time() - last_update < 0.5:
                continue

            # Get current thinking (excluding already-sent overflow parts)
            sent_thinking_len = sum(len(p) for p in sent_thinking_parts)
            current_thinking = reasoning[sent_thinking_len:]

            if show_thinking and current_thinking and not thinking_finalized and not pending_tool and not final_content_confirmed:
                # Check for thinking overflow (~3800 chars formatted)
                thinking_expanded = format_thinking_expanded(current_thinking)
                if len(thinking_expanded) >= SAFE_MESSAGE_LENGTH - 100:
                    # Collapse and send overflow as permanent message
                    part_to_send, remaining_thinking = split_thinking(
                        current_thinking, SAFE_MESSAGE_LENGTH - 200
                    )
                    if part_to_send:
                        collapsed = format_thinking_collapsed(part_to_send)
                        await _send_with_markdown_fallback(
                            bot, chat_id, collapsed, thread_id, convert=False
                        )
                        sent_thinking_parts.append(part_to_send)
                        # Generate new draft ID for continued thinking
                        unified_draft_id = generate_draft_id()
                        current_thinking = remaining_thinking

                # Update draft with expanded thinking (visible while streaming)
                if current_thinking:
                    thinking_expanded = format_thinking_expanded(current_thinking)
                    await _send_draft_with_fallback(
                        bot,
                        chat_id,
                        unified_draft_id,
                        thinking_expanded[:SAFE_MESSAGE_LENGTH],
                        thread_id,
                        thinking_expanded[:SAFE_MESSAGE_LENGTH],
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

                    # Finalize thinking first (send all remaining as collapsed)
                    if show_thinking and reasoning and not thinking_finalized:
                        sent_thinking_len = sum(len(p) for p in sent_thinking_parts)
                        remaining_thinking = reasoning[sent_thinking_len:]
                        if remaining_thinking:
                            collapsed = format_thinking_collapsed(remaining_thinking)
                            await _send_with_markdown_fallback(
                                bot, chat_id, collapsed, thread_id, convert=False
                            )
                        thinking_finalized = True
                        # Generate new draft for content
                        unified_draft_id = generate_draft_id()

                    # Send content part
                    try:
                        await _send_with_markdown_fallback(bot, chat_id, part, thread_id)
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
                    unified_draft_id = generate_draft_id()

                    last_update = time.time()
                    continue

            # Check for final content confirmation (both modes)
            if not final_content_confirmed and len(preview.strip()) >= FINAL_CONTENT_MIN_LENGTH:
                final_content_confirmed = True

            # Update content draft
            if preview.strip() and final_content_confirmed:
                if not show_thinking or thinking_finalized:
                    # Non-thinking mode or thinking already finalized: stream content directly
                    draft_text = ("```\n" + preview if in_code_block else preview)[
                        :SAFE_MESSAGE_LENGTH
                    ]
                    formatted = convert_to_telegram_markdown(draft_text)
                    await _send_draft_with_fallback(
                        bot, chat_id, unified_draft_id, draft_text, thread_id, formatted
                    )
                    thinking_msg_replaced = True
                else:
                    # show_thinking mode with thinking not finalized: show combined draft
                    sent_thinking_len = sum(len(p) for p in sent_thinking_parts)
                    current_thinking = reasoning[sent_thinking_len:]
                    if current_thinking:
                        combined = format_thinking_with_content(current_thinking, preview)
                        if len(combined) <= SAFE_MESSAGE_LENGTH:
                            await _send_draft_with_fallback(
                                bot, chat_id, unified_draft_id, combined, thread_id, combined
                            )
                            thinking_msg_replaced = True

            last_update = time.time()

    except Exception as e:
        logger.error(f"Error generating response: {e}")
        content = "Sorry, an error occurred."

    # Handle final message
    final_content = content or "No response generated."
    sent_len = sum(len(p) for p in sent_parts)
    remaining = final_content[sent_len:] if sent_len < len(final_content) else final_content
    sent_thinking_len = sum(len(p) for p in sent_thinking_parts)
    remaining_thinking = reasoning[sent_thinking_len:] if reasoning else ""

    if show_thinking and remaining_thinking and not thinking_finalized:
        # Try to combine thinking + content in single message
        if remaining.strip():
            combined = format_thinking_with_content(remaining_thinking, remaining)
            if len(combined) <= SAFE_MESSAGE_LENGTH:
                # Update draft with combined, then send
                await _send_draft_with_fallback(
                    bot, chat_id, unified_draft_id, combined, thread_id, combined
                )
                await _send_with_markdown_fallback(bot, chat_id, combined, thread_id, convert=False)
                remaining = ""  # Already sent
            else:
                # Send thinking separately (collapsed)
                collapsed = format_thinking_collapsed(remaining_thinking)
                await _send_with_markdown_fallback(bot, chat_id, collapsed, thread_id, convert=False)
                await asyncio.sleep(0.1)
        else:
            # No content, just send thinking
            collapsed = format_thinking_collapsed(remaining_thinking)
            await _send_with_markdown_fallback(bot, chat_id, collapsed, thread_id, convert=False)

    # Send remaining content (if not already combined)
    if remaining.strip():
        if in_code_block:
            remaining = "```\n" + remaining

        parts = split_message(remaining)

        # Update draft with final content before sending (smooth transition)
        if not sent_parts and not (show_thinking and remaining_thinking):
            formatted = convert_to_telegram_markdown(parts[0])
            await _send_draft_with_fallback(
                bot, chat_id, unified_draft_id, parts[0], thread_id, formatted
            )

        for i, part in enumerate(parts):
            if i > 0 or sent_parts:
                await asyncio.sleep(0.1)
            await _send_with_markdown_fallback(bot, chat_id, part, thread_id)

    # Save assistant response
    async with repository.session_factory() as session:
        conv = await repository.get_or_create_conversation(session, user.id, chat_id, thread_id)
        await repository.add_message(session, conv.id, "assistant", content)
        await session.commit()
