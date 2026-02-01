"""Message handling logic for aiogram."""

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from aiogram import Bot, F, Router
from aiogram.exceptions import TelegramBadRequest, TelegramRetryAfter
from aiogram.types import Message

from bot.ai.openrouter import openrouter_client
from bot.config import settings
from bot.database.models import Message as DbMessage
from bot.database.repository import repository
from bot.i18n import Language, get_text
from bot.telegram.files import download_and_encode_image, download_and_encode_pdf
from bot.telegram.filters import ApprovedUserFilter
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


@dataclass
class StreamingResult:
    """Result of a streaming response generation."""

    content: str
    sent_message_ids: list[int] = field(default_factory=list)

    @property
    def first_message_id(self) -> int | None:
        """Get first sent message ID or None."""
        return self.sent_message_ids[0] if self.sent_message_ids else None


@dataclass
class StreamingState:
    """Tracks state during response streaming."""

    content: str = ""
    reasoning: str = ""
    sent_parts: list[str] = field(default_factory=list)
    sent_thinking_parts: list[str] = field(default_factory=list)
    sent_message_ids: list[int] = field(default_factory=list)
    thinking_finalized: bool = False
    in_code_block: bool = False
    thinking_msg_replaced: bool = False
    pending_tool: str | None = None
    current_status_text: str = ""
    final_content_confirmed: bool = False
    last_update: float = 0.0
    draft_id: int = field(default_factory=generate_draft_id)
    tool_counts: dict[str, int] = field(default_factory=dict)
    lang: Language = Language.EN

    @property
    def sent_content_len(self) -> int:
        """Total length of content already sent as permanent messages."""
        return sum(len(p) for p in self.sent_parts)

    @property
    def sent_thinking_len(self) -> int:
        """Total length of thinking already sent as permanent messages."""
        return sum(len(p) for p in self.sent_thinking_parts)

    @property
    def current_thinking(self) -> str:
        """Get thinking text not yet sent as permanent messages."""
        return self.reasoning[self.sent_thinking_len:]

    @property
    def current_preview(self) -> str:
        """Get content text not yet sent as permanent messages."""
        return self.content[self.sent_content_len:] if self.content else ""

    def new_draft_id(self) -> int:
        """Generate and set a new draft ID."""
        self.draft_id = generate_draft_id()
        return self.draft_id


logger = logging.getLogger(__name__)

router = Router(name="messages")

# System prompt template path and cache
_SYS_PROMPT_PATH = Path(__file__).parent.parent.parent.parent / "SYS_PROMPT.md"
_sys_prompt_template: str | None = None

# Human-readable language names for system prompt
_LANG_NAMES: dict[str, str] = {
    Language.EN.value: "English",
    Language.RU.value: "Russian",
    Language.UK.value: "Ukrainian",
}


def _get_sys_prompt_template() -> str:
    """Load and cache system prompt template from SYS_PROMPT.md."""
    global _sys_prompt_template
    if _sys_prompt_template is None:
        _sys_prompt_template = _SYS_PROMPT_PATH.read_text(encoding="utf-8")
    return _sys_prompt_template


async def _build_system_prompt(user_name: str, user_lang: str, bot: Bot) -> str:
    """Build system prompt with runtime values."""
    now = datetime.now(UTC)
    bot_info = await bot.get_me()
    lang_name = _LANG_NAMES.get(user_lang, _LANG_NAMES[Language.EN.value])

    return _get_sys_prompt_template().format(
        model_name=settings.openrouter_model,
        bot_name=bot_info.first_name,
        time=now.strftime("%H:%M"),
        timezone="UTC",
        date=now.strftime("%Y-%m-%d"),
        user_name=user_name,
        user_lang=lang_name,
    )


def _get_tool_status_text(tool_name: str, count: int, lang: Language) -> str:
    """Get user-friendly status text for a tool with emoji and counter."""
    tool_key_map = {
        "web_search": ("status_searching", "\U0001F50D"),  # magnifying glass
        "extract_webpage": ("status_reading", "\U0001F4C4"),  # page
    }

    if tool_name in tool_key_map:
        key, emoji = tool_key_map[tool_name]
        text = get_text(key, lang)
    else:
        emoji = "\U0001F527"  # wrench
        text = f"Using {tool_name}\\.\\.\\."

    result = f"{emoji} {text}"

    if count > 1:
        result += f" \\(x{count}\\)"

    return result


def _get_thinking_status_text(lang: Language) -> str:
    """Get thinking status text with emoji."""
    return f"\U0001F914 {get_text('status_thinking', lang)}"  # thinking face emoji


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


async def generate_and_stream_response(
    bot: Bot,
    chat_id: int,
    thread_id: int | None,
    ai_messages: list[dict[str, Any]],
    show_thinking: bool,
    lang: str = "en",
) -> StreamingResult:
    """Generate and stream an AI response to the chat.

    Returns StreamingResult with the final content and list of sent Telegram message IDs.
    """
    try:
        user_lang = Language(lang)
    except ValueError:
        user_lang = Language.EN

    state = StreamingState(lang=user_lang)
    thinking_status = _get_thinking_status_text(user_lang)
    state.current_status_text = thinking_status

    try:
        await _send_draft_with_fallback(bot, chat_id, state.draft_id, thinking_status, thread_id)

        async for chunk in openrouter_client.generate_response_stream(ai_messages, show_thinking):
            await _handle_chunk(bot, chat_id, thread_id, chunk, state, show_thinking)

            if time.time() - state.last_update < 0.5:
                continue

            if show_thinking and not state.thinking_finalized and not state.pending_tool and not state.final_content_confirmed:
                await _handle_thinking_overflow(bot, chat_id, thread_id, state)

            await _handle_content_overflow(bot, chat_id, thread_id, state, show_thinking)

            await _update_content_draft(bot, chat_id, thread_id, state, show_thinking)

            state.last_update = time.time()

    except Exception as e:
        logger.error(f"Error generating response: {e}")
        state.content = "Sorry, an error occurred."

    await _finalize_response(bot, chat_id, thread_id, state, show_thinking)

    return StreamingResult(content=state.content, sent_message_ids=state.sent_message_ids)


async def _handle_chunk(
    bot: Bot,
    chat_id: int,
    thread_id: int | None,
    chunk: Any,
    state: StreamingState,
    show_thinking: bool,
) -> None:
    """Process a single chunk from the AI stream."""
    # Prepend tool indicator when new thinking arrives after tool use
    if chunk.reasoning and state.pending_tool:
        state.reasoning += f"(Used {state.pending_tool})\n"
        state.pending_tool = None
        # Restore "Thinking..." status after tool completes (non-thinking mode)
        thinking_status = _get_thinking_status_text(state.lang)
        if not show_thinking and not state.thinking_msg_replaced:
            if state.current_status_text != thinking_status:
                await _send_draft_with_fallback(bot, chat_id, state.draft_id, thinking_status, thread_id)
                state.current_status_text = thinking_status

    state.reasoning += chunk.reasoning
    state.content += chunk.content

    if chunk.is_tool_use:
        await _handle_tool_use(bot, chat_id, thread_id, chunk, state, show_thinking)


async def _handle_tool_use(
    bot: Bot,
    chat_id: int,
    thread_id: int | None,
    chunk: Any,
    state: StreamingState,
    show_thinking: bool,
) -> None:
    """Handle tool use chunk by moving content to thinking and updating draft."""
    step_content = state.current_preview
    if step_content.strip():
        state.reasoning += f"\n{step_content.strip()}\n"
        state.sent_parts.append(step_content)

    state.pending_tool = chunk.tool_name
    state.final_content_confirmed = False
    state.thinking_msg_replaced = False

    # Increment tool usage counter
    state.tool_counts[chunk.tool_name] = state.tool_counts.get(chunk.tool_name, 0) + 1
    count = state.tool_counts[chunk.tool_name]

    new_text = _get_tool_status_text(chunk.tool_name, count, state.lang)

    if show_thinking and state.reasoning:
        current_thinking = state.current_thinking
        if current_thinking:
            status_plain = new_text.replace("\\\\", "").replace("\\.", ".")
            thinking_with_status = format_thinking_expanded(current_thinking + f"\n{status_plain}")
            await _send_draft_with_fallback(
                bot, chat_id, state.draft_id, thinking_with_status, thread_id, thinking_with_status
            )
        else:
            await _send_draft_with_fallback(bot, chat_id, state.draft_id, new_text, thread_id)
    else:
        await _send_draft_with_fallback(bot, chat_id, state.draft_id, new_text, thread_id)

    state.current_status_text = new_text


async def _handle_thinking_overflow(
    bot: Bot,
    chat_id: int,
    thread_id: int | None,
    state: StreamingState,
) -> None:
    """Handle thinking overflow by sending excess as collapsed permanent message."""
    current_thinking = state.current_thinking
    if not current_thinking:
        return

    thinking_expanded = format_thinking_expanded(current_thinking)
    if len(thinking_expanded) >= SAFE_MESSAGE_LENGTH - 100:
        part_to_send, remaining = split_thinking(current_thinking, SAFE_MESSAGE_LENGTH - 200)
        if part_to_send:
            collapsed = format_thinking_collapsed(part_to_send)
            sent_msg = await _send_with_markdown_fallback(bot, chat_id, collapsed, thread_id, convert=False)
            state.sent_message_ids.append(sent_msg.message_id)
            state.sent_thinking_parts.append(part_to_send)
            state.new_draft_id()
            current_thinking = remaining

    if current_thinking:
        thinking_expanded = format_thinking_expanded(current_thinking)
        await _send_draft_with_fallback(
            bot, chat_id, state.draft_id,
            thinking_expanded[:SAFE_MESSAGE_LENGTH], thread_id,
            thinking_expanded[:SAFE_MESSAGE_LENGTH],
        )


async def _handle_content_overflow(
    bot: Bot,
    chat_id: int,
    thread_id: int | None,
    state: StreamingState,
    show_thinking: bool,
) -> None:
    """Handle content overflow by sending as permanent message."""
    preview = state.current_preview

    if len(preview) < SAFE_MESSAGE_LENGTH - 100:
        return

    split_point = find_split_point(preview, SAFE_MESSAGE_LENGTH - 200)
    part = preview[:split_point].rstrip()

    if not part:
        return

    if state.in_code_block:
        part = "```\n" + part
    ends_mid_block = part.count("```") % 2 == 1

    # Finalize thinking first if needed
    if show_thinking and state.reasoning and not state.thinking_finalized:
        remaining_thinking = state.current_thinking
        if remaining_thinking:
            collapsed = format_thinking_collapsed(remaining_thinking)
            sent_msg = await _send_with_markdown_fallback(bot, chat_id, collapsed, thread_id, convert=False)
            state.sent_message_ids.append(sent_msg.message_id)
        state.thinking_finalized = True
        state.new_draft_id()

    # Send content part
    try:
        sent_msg = await _send_with_markdown_fallback(bot, chat_id, part, thread_id)
        state.sent_message_ids.append(sent_msg.message_id)
    except TelegramRetryAfter as e:
        await asyncio.sleep(e.retry_after)
        sent_msg = await bot.send_message(
            chat_id=chat_id, text=part, message_thread_id=thread_id, parse_mode=None
        )
        state.sent_message_ids.append(sent_msg.message_id)

    state.in_code_block = ends_mid_block
    state.sent_parts.append(part)
    state.new_draft_id()
    state.last_update = time.time()


async def _update_content_draft(
    bot: Bot,
    chat_id: int,
    thread_id: int | None,
    state: StreamingState,
    show_thinking: bool,
) -> None:
    """Update the draft message with current content preview."""
    preview = state.current_preview

    if not state.final_content_confirmed and len(preview.strip()) >= FINAL_CONTENT_MIN_LENGTH:
        state.final_content_confirmed = True

    if not preview.strip() or not state.final_content_confirmed:
        return

    if not show_thinking or state.thinking_finalized:
        draft_text = ("```\n" + preview if state.in_code_block else preview)[:SAFE_MESSAGE_LENGTH]
        formatted = convert_to_telegram_markdown(draft_text)
        await _send_draft_with_fallback(bot, chat_id, state.draft_id, draft_text, thread_id, formatted)
        state.thinking_msg_replaced = True
    else:
        current_thinking = state.current_thinking
        if current_thinking:
            combined = format_thinking_with_content(current_thinking, preview)
            if len(combined) <= SAFE_MESSAGE_LENGTH:
                await _send_draft_with_fallback(bot, chat_id, state.draft_id, combined, thread_id, combined)
                state.thinking_msg_replaced = True


async def _finalize_response(
    bot: Bot,
    chat_id: int,
    thread_id: int | None,
    state: StreamingState,
    show_thinking: bool,
) -> None:
    """Send final messages after streaming completes."""
    final_content = state.content or "No response generated."
    remaining = final_content[state.sent_content_len:] if state.sent_content_len < len(final_content) else final_content
    remaining_thinking = state.current_thinking if state.reasoning else ""

    if show_thinking and remaining_thinking and not state.thinking_finalized:
        remaining = await _send_final_thinking(
            bot, chat_id, thread_id, state, remaining, remaining_thinking
        )

    if remaining.strip():
        await _send_final_content(bot, chat_id, thread_id, state, remaining, remaining_thinking, show_thinking)


async def _send_final_thinking(
    bot: Bot,
    chat_id: int,
    thread_id: int | None,
    state: StreamingState,
    remaining: str,
    remaining_thinking: str,
) -> str:
    """Send final thinking block, possibly combined with content."""
    if remaining.strip():
        combined = format_thinking_with_content(remaining_thinking, remaining)
        if len(combined) <= SAFE_MESSAGE_LENGTH:
            await _send_draft_with_fallback(bot, chat_id, state.draft_id, combined, thread_id, combined)
            sent_msg = await _send_with_markdown_fallback(bot, chat_id, combined, thread_id, convert=False)
            state.sent_message_ids.append(sent_msg.message_id)
            return ""  # Already sent
        else:
            collapsed = format_thinking_collapsed(remaining_thinking)
            sent_msg = await _send_with_markdown_fallback(bot, chat_id, collapsed, thread_id, convert=False)
            state.sent_message_ids.append(sent_msg.message_id)
            await asyncio.sleep(0.1)
    else:
        collapsed = format_thinking_collapsed(remaining_thinking)
        sent_msg = await _send_with_markdown_fallback(bot, chat_id, collapsed, thread_id, convert=False)
        state.sent_message_ids.append(sent_msg.message_id)

    return remaining


async def _send_final_content(
    bot: Bot,
    chat_id: int,
    thread_id: int | None,
    state: StreamingState,
    remaining: str,
    remaining_thinking: str,
    show_thinking: bool,
) -> None:
    """Send remaining content as final messages."""
    if state.in_code_block:
        remaining = "```\n" + remaining

    parts = split_message(remaining)

    # Update draft with final content before sending (smooth transition)
    if not state.sent_parts and not (show_thinking and remaining_thinking):
        formatted = convert_to_telegram_markdown(parts[0])
        await _send_draft_with_fallback(bot, chat_id, state.draft_id, parts[0], thread_id, formatted)

    for i, part in enumerate(parts):
        if i > 0 or state.sent_parts:
            await asyncio.sleep(0.1)
        sent_msg = await _send_with_markdown_fallback(bot, chat_id, part, thread_id)
        state.sent_message_ids.append(sent_msg.message_id)


@router.message(ApprovedUserFilter(), F.text & ~F.text.startswith("/") | F.photo | F.document)
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
        user = await repository.get_or_create_user(session, user_data.id)
        conv = await repository.get_or_create_conversation(session, user.id, chat_id, thread_id)
        await repository.add_message(
            session, conv.id, "user", text, message.message_id, image_id, pdf_id
        )
        db_messages = await repository.get_conversation_messages(session, conv.id)
        show_thinking = user.show_thinking
        lang = user.language
        await session.commit()

    # Prepare AI messages with system prompt
    ai_messages = trim_messages_to_limit(await _format_history(db_messages, bot))
    system_prompt = await _build_system_prompt(user_data.first_name or "User", lang, bot)
    ai_messages.insert(0, {"role": "system", "content": system_prompt})

    # Send thinking indicator
    await bot.send_chat_action(chat_id, "typing", message_thread_id=thread_id)

    # Generate and stream the response
    result = await generate_and_stream_response(bot, chat_id, thread_id, ai_messages, show_thinking, lang)

    # Save assistant response
    async with repository.session_factory() as session:
        conv = await repository.get_or_create_conversation(session, user.id, chat_id, thread_id)
        await repository.add_message(
            session, conv.id, "assistant", result.content, message_id=result.first_message_id
        )
        await session.commit()
