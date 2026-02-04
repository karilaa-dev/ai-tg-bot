"""Message handling logic for aiogram."""

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from aiogram import Bot, F, Router
from aiogram.exceptions import TelegramBadRequest, TelegramRetryAfter
from aiogram.types import Message

from bot.ai.openrouter import openrouter_client
from bot.config import settings
from bot.database.models import ConversationFile, Message as DbMessage
from bot.database.repository import repository
from bot.i18n import Language, get_text
from bot.ai.tika import extract_pdf_text
from bot.telegram.files import download_and_encode_image, download_file_bytes, download_text_file
from bot.telegram.filters import ApprovedUserFilter
from bot.utils import (
    SAFE_MESSAGE_LENGTH,
    convert_to_telegram_markdown,
    find_split_point,
    format_thinking_collapsed,
    format_thinking_expanded,
    format_thinking_with_content,
    format_timezone_offset,
    generate_draft_id,
    split_thinking,
)
from bot.utils.formatting import _escape_markdown_v2_full

# Refresh "Thinking..." draft every 20 seconds when no chunks arrive
THINKING_REFRESH_INTERVAL = 20.0
MEDIA_GROUP_DELAY = 1.0
TEXT_FILE_SIZE_LIMIT = 1_000_000


@dataclass
class MediaGroupBuffer:
    """Buffered media group data for aggregation."""

    chat_id: int
    thread_id: int | None
    media_group_id: str
    user: Any
    image_ids: list[str] = field(default_factory=list)
    text: str = ""
    message_id: int | None = None


_MEDIA_GROUPS: dict[tuple[int, int | None, str], MediaGroupBuffer] = {}
_MEDIA_GROUPS_LOCK = asyncio.Lock()


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


async def _build_system_prompt(
    user_name: str, user_lang: str, bot: Bot, timezone_offset: int = 0
) -> str:
    """Build system prompt with runtime values."""
    now_utc = datetime.now(UTC)
    # Convert UTC to user's local time
    user_time = now_utc + timedelta(minutes=timezone_offset)
    bot_info = await bot.get_me()
    lang_name = _LANG_NAMES.get(user_lang, _LANG_NAMES[Language.EN.value])
    timezone_str = format_timezone_offset(timezone_offset)

    return _get_sys_prompt_template().format(
        model_name=settings.openrouter_model,
        bot_name=bot_info.first_name,
        time=user_time.strftime("%H:%M"),
        timezone=timezone_str,
        date=user_time.strftime("%Y-%m-%d"),
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


async def _iter_with_timeout(
    stream: Any, timeout_seconds: float
) -> Any:
    """Iterate over stream, yielding timeout events when no chunks arrive.

    Yields tuples of (chunk, is_timeout) where is_timeout is True when
    the timeout was reached without receiving a chunk.

    Uses asyncio.wait instead of wait_for to avoid cancelling the pending
    task on timeout, which would disrupt the async generator's state.
    """
    aiter = stream.__aiter__()
    pending_task: asyncio.Task[Any] | None = None

    while True:
        if pending_task is None:
            pending_task = asyncio.create_task(aiter.__anext__())

        done, _ = await asyncio.wait({pending_task}, timeout=timeout_seconds)

        if done:
            task = done.pop()
            pending_task = None
            try:
                chunk = task.result()
                yield (chunk, False)
            except StopAsyncIteration:
                return
        else:
            # Timeout - task still pending, will check again next iteration
            yield (None, True)


async def _refresh_thinking_draft(
    bot: Bot,
    chat_id: int,
    thread_id: int | None,
    state: StreamingState,
    show_thinking: bool,
) -> None:
    """Refresh the thinking draft to keep it from appearing stuck."""
    if state.final_content_confirmed:
        return  # Already showing content, no need to refresh

    # Re-send current thinking or status text
    if show_thinking and state.current_thinking and not state.thinking_finalized:
        thinking_expanded = format_thinking_expanded(state.current_thinking)
        await _send_draft_with_fallback(
            bot, chat_id, state.draft_id,
            thinking_expanded[:SAFE_MESSAGE_LENGTH], thread_id,
            thinking_expanded[:SAFE_MESSAGE_LENGTH],
        )
    else:
        await _send_draft_with_fallback(
            bot, chat_id, state.draft_id, state.current_status_text, thread_id
        )

    state.last_update = time.time()


def _get_last_user_message(messages: list[DbMessage]) -> DbMessage | None:
    """Get the most recent user message from a list."""
    for msg in reversed(messages):
        if msg.role == "user":
            return msg
    return None


def _format_history(messages: list[DbMessage]) -> list[dict[str, Any]]:
    """Convert database messages to OpenRouter format (text-only)."""
    return [{"role": m.role, "content": m.content or ""} for m in messages]


def _collect_conversation_files(
    files: list[ConversationFile],
) -> tuple[list[ConversationFile], list[ConversationFile], list[ConversationFile]]:
    """Collect files by type for request building."""
    text_files: list[ConversationFile] = []
    image_files: list[ConversationFile] = []
    pdf_files: list[ConversationFile] = []

    for file in files:
        if file.file_type == "text" and file.text_content:
            text_files.append(file)
            continue
        if file.file_type == "image":
            image_files.append(file)
            continue
        if file.file_type == "pdf":
            if file.text_content:
                pdf_files.append(file)
            else:
                logger.debug("PDF file missing text content: %s", file.file_id)

    return text_files, image_files, pdf_files


def _fit_formatted_chunk(
    text: str,
    max_length: int,
    formatter: Any,
) -> tuple[str, str, str]:
    """Find the largest prefix that fits within max_length after formatting."""
    if not text:
        return "", "", ""

    low, high = 1, len(text)
    best_raw = ""
    best_formatted = ""

    while low <= high:
        mid = (low + high) // 2
        raw = text[:mid]
        formatted = formatter(raw)

        if len(formatted) <= max_length:
            best_raw = raw
            best_formatted = formatted
            low = mid + 1
        else:
            high = mid - 1

    if not best_raw:
        raw = text[:1]
        formatted = formatter(raw)
        logger.debug(
            "fit_chunk: fallback to single char, formatted_len=%d max=%d",
            len(formatted),
            max_length,
        )
        return raw, formatted, text[1:]

    remaining = text[len(best_raw):]
    logger.debug(
        "fit_chunk: raw_len=%d formatted_len=%d remaining_len=%d max=%d",
        len(best_raw),
        len(best_formatted),
        len(remaining),
        max_length,
    )
    return best_raw, best_formatted, remaining


def _split_message_for_markdown(text: str, max_length: int = SAFE_MESSAGE_LENGTH) -> list[str]:
    """Split text into chunks that fit after Markdown conversion."""
    if not text:
        return []

    parts: list[str] = []
    remaining = text

    while remaining:
        raw, _formatted, rest = _fit_formatted_chunk(
            remaining, max_length, convert_to_telegram_markdown
        )
        if not raw:
            break
        parts.append(raw.rstrip())
        remaining = rest.lstrip()

    logger.debug(
        "split_markdown: raw_len=%d parts=%d max=%d",
        len(text),
        len(parts),
        max_length,
    )
    return parts


async def _build_user_content(
    text: str,
    text_files: list[ConversationFile],
    image_files: list[ConversationFile],
    pdf_files: list[ConversationFile],
    bot: Bot,
) -> str | list[dict[str, Any]]:
    """Build OpenRouter message content with persistent attachments."""
    parts: list[dict[str, Any]] = []

    if text:
        parts.append({"type": "text", "text": text})

    for file in text_files:
        name = file.file_name or "file.txt"
        parts.append({"type": "text", "text": f"File: {name}\n{file.text_content}"})

    for file in image_files:
        if data := await download_and_encode_image(file.file_id, bot):
            parts.append({"type": "image_url", "image_url": {"url": data}})

    for file in pdf_files:
        name = file.file_name or "document.pdf"
        parts.append({"type": "text", "text": f"PDF: {name}\n{file.text_content}"})

    if len(parts) == 1 and parts[0].get("type") == "text":
        return parts[0]["text"]
    return parts


async def _build_ai_messages(
    db_messages: list[DbMessage],
    files: list[ConversationFile],
    system_prompt: str,
    bot: Bot,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Build OpenRouter messages including persistent attachments."""
    last_user = _get_last_user_message(db_messages)
    history_messages = [m for m in db_messages if not last_user or m.id != last_user.id]
    ai_messages = _format_history(history_messages)

    text_files, image_files, pdf_files = _collect_conversation_files(files)

    if last_user:
        user_content = await _build_user_content(
            last_user.content,
            text_files,
            image_files,
            pdf_files,
            bot,
        )
        ai_messages.append({"role": "user", "content": user_content})

    ai_messages.insert(0, {"role": "system", "content": system_prompt})
    return ai_messages, []


async def _flush_media_group(
    key: tuple[int, int | None, str], bot: Bot
) -> None:
    """Flush a buffered media group after a short delay."""
    await asyncio.sleep(MEDIA_GROUP_DELAY)
    async with _MEDIA_GROUPS_LOCK:
        buffer = _MEDIA_GROUPS.pop(key, None)
    if not buffer:
        return

    await _handle_incoming_payload(
        bot=bot,
        chat_id=buffer.chat_id,
        thread_id=buffer.thread_id,
        user_data=buffer.user,
        text=buffer.text,
        image_ids=buffer.image_ids,
        document=None,
        message_id=buffer.message_id,
    )


async def _send_with_markdown_fallback(
    bot: Bot,
    chat_id: int,
    text: str,
    thread_id: int | None,
    convert: bool = True,
) -> Message:
    """Send message with MarkdownV2, ensuring formatting always succeeds."""
    formatter = convert_to_telegram_markdown if convert else (lambda s: s)
    raw_to_send = text
    formatted = formatter(raw_to_send)

    if len(formatted) > SAFE_MESSAGE_LENGTH:
        logger.debug(
            "send_markdown: formatted too long (%d), trimming",
            len(formatted),
        )
        raw_to_send, formatted, _ = _fit_formatted_chunk(
            raw_to_send, SAFE_MESSAGE_LENGTH, formatter
        )

    try:
        return await bot.send_message(
            chat_id=chat_id,
            text=formatted,
            message_thread_id=thread_id,
            parse_mode="MarkdownV2",
        )
    except TelegramBadRequest as e:
        message = str(e).lower()
        if "parse" in message or "too long" in message:
            logger.debug(
                "send_markdown: retry with escaped markdown due to error: %s",
                message,
            )
            escaped_raw, escaped_formatted, _ = _fit_formatted_chunk(
                raw_to_send, SAFE_MESSAGE_LENGTH, _escape_markdown_v2_full
            )
            return await bot.send_message(
                chat_id=chat_id,
                text=escaped_formatted,
                message_thread_id=thread_id,
                parse_mode="MarkdownV2",
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
    """Send draft message with MarkdownV2, ensuring formatting always succeeds."""
    formatter = (lambda s: s) if formatted is not None else convert_to_telegram_markdown
    raw_to_send = text
    formatted_text = formatted if formatted is not None else formatter(raw_to_send)

    if len(formatted_text) > SAFE_MESSAGE_LENGTH:
        logger.debug(
            "send_draft: formatted too long (%d), trimming",
            len(formatted_text),
        )
        raw_to_send, formatted_text, _ = _fit_formatted_chunk(
            raw_to_send, SAFE_MESSAGE_LENGTH, formatter
        )

    try:
        await bot.send_message_draft(
            chat_id=chat_id,
            draft_id=draft_id,
            text=formatted_text,
            message_thread_id=thread_id,
            parse_mode="MarkdownV2",
        )
    except TelegramBadRequest as e:
        message = str(e).lower()
        if "parse" in message or "too long" in message:
            logger.debug(
                "send_draft: retry with escaped markdown due to error: %s",
                message,
            )
            _raw, escaped_formatted, _ = _fit_formatted_chunk(
                raw_to_send, SAFE_MESSAGE_LENGTH, _escape_markdown_v2_full
            )
            await bot.send_message_draft(
                chat_id=chat_id,
                draft_id=draft_id,
                text=escaped_formatted,
                message_thread_id=thread_id,
                parse_mode="MarkdownV2",
            )
        else:
            raise


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

        stream = openrouter_client.generate_response_stream(ai_messages, show_thinking)
        async for chunk, is_timeout in _iter_with_timeout(stream, THINKING_REFRESH_INTERVAL):
            if is_timeout:
                await _refresh_thinking_draft(bot, chat_id, thread_id, state, show_thinking)
                continue

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

    return StreamingResult(
        content=state.content,
        sent_message_ids=state.sent_message_ids,
    )


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

    parts = _split_message_for_markdown(remaining)

    # Update draft with final content before sending (smooth transition)
    if not state.sent_parts and not (show_thinking and remaining_thinking):
        formatted = convert_to_telegram_markdown(parts[0])
        await _send_draft_with_fallback(bot, chat_id, state.draft_id, parts[0], thread_id, formatted)

    for i, part in enumerate(parts):
        if i > 0 or state.sent_parts:
            await asyncio.sleep(0.1)
        sent_msg = await _send_with_markdown_fallback(bot, chat_id, part, thread_id)
        state.sent_message_ids.append(sent_msg.message_id)


async def _queue_media_group(message: Message, bot: Bot) -> None:
    """Buffer a media group and process it after a short delay."""
    if not message.media_group_id or not message.from_user:
        return

    chat_id = message.chat.id
    thread_id = message.message_thread_id
    key = (chat_id, thread_id, message.media_group_id)

    async with _MEDIA_GROUPS_LOCK:
        buffer = _MEDIA_GROUPS.get(key)
        if not buffer:
            buffer = MediaGroupBuffer(
                chat_id=chat_id,
                thread_id=thread_id,
                media_group_id=message.media_group_id,
                user=message.from_user,
            )
            _MEDIA_GROUPS[key] = buffer
            asyncio.create_task(_flush_media_group(key, bot))

        if message.photo:
            buffer.image_ids.append(message.photo[-1].file_id)

        if message.caption and not buffer.text:
            buffer.text = message.caption

        if buffer.message_id is None:
            buffer.message_id = message.message_id


async def _handle_incoming_payload(
    bot: Bot,
    chat_id: int,
    thread_id: int | None,
    user_data: Any,
    text: str,
    image_ids: list[str],
    document: Any | None,
    message_id: int | None,
) -> None:
    """Process a single incoming payload (message or media group)."""
    if not user_data:
        return

    text = text or ""
    image_ids = image_ids or []

    pdf_id: str | None = None
    pdf_name: str | None = None
    text_file_id: str | None = None
    text_file_name: str | None = None

    if document:
        file_name = document.file_name or ""
        lower_name = file_name.lower()
        mime_type = document.mime_type or ""

        if mime_type == "application/pdf" or lower_name.endswith(".pdf"):
            pdf_id = document.file_id
            pdf_name = file_name or "document.pdf"
        elif lower_name.endswith(".txt") or lower_name.endswith(".md"):
            text_file_id = document.file_id
            text_file_name = file_name or "document.txt"

    if not text and not image_ids and not pdf_id and not text_file_id:
        return

    async with repository.session_factory() as session:
        user = await repository.get_or_create_user(session, user_data.id)
        conv = await repository.get_or_create_conversation(session, user.id, chat_id, thread_id)
        lang = user.language
        show_thinking = user.show_thinking
        timezone_offset = user.timezone_offset

        if text_file_id and document and document.file_size:
            if document.file_size > TEXT_FILE_SIZE_LIMIT:
                await session.commit()
                await _send_with_markdown_fallback(
                    bot,
                    chat_id,
                    get_text("text_file_too_large", lang),
                    thread_id,
                    convert=False,
                )
                return

        for image_id in image_ids:
            await repository.add_conversation_file(session, conv.id, image_id, "image")

        if pdf_id:
            existing_pdf = await repository.get_conversation_file(
                session, conv.id, pdf_id, "pdf"
            )
            if not existing_pdf or not existing_pdf.text_content:
                if data := await download_file_bytes(pdf_id, bot):
                    pdf_bytes, filename = data
                    try:
                        extracted = await extract_pdf_text(pdf_bytes)
                    except Exception as e:
                        logger.error("PDF parse failed: %s", e)
                        await session.commit()
                        await _send_with_markdown_fallback(
                            bot,
                            chat_id,
                            get_text("pdf_parse_failed", lang),
                            thread_id,
                        )
                        return

                    if len(extracted) > settings.pdf_text_char_limit:
                        await session.commit()
                        await _send_with_markdown_fallback(
                            bot,
                            chat_id,
                            get_text("pdf_too_large", lang),
                            thread_id,
                        )
                        return

                    if existing_pdf:
                        existing_pdf.text_content = extracted
                        if not existing_pdf.file_name:
                            existing_pdf.file_name = pdf_name or filename
                    else:
                        await repository.add_conversation_file(
                            session,
                            conv.id,
                            pdf_id,
                            "pdf",
                            file_name=pdf_name or filename,
                            text_content=extracted,
                        )
                else:
                    await session.commit()
                    await _send_with_markdown_fallback(
                        bot,
                        chat_id,
                        get_text("pdf_parse_failed", lang),
                        thread_id,
                    )
                    return

        if text_file_id:
            existing = await repository.get_conversation_file(
                session, conv.id, text_file_id, "text"
            )
            if not existing:
                if data := await download_text_file(text_file_id, bot):
                    text_content, filename = data
                    await repository.add_conversation_file(
                        session,
                        conv.id,
                        text_file_id,
                        "text",
                        file_name=text_file_name or filename,
                        text_content=text_content,
                    )

        await repository.add_message(
            session,
            conv.id,
            "user",
            text,
            message_id,
            image_ids[-1] if image_ids else None,
            pdf_id,
        )

        db_messages = await repository.get_conversation_messages(session, conv.id)
        conv_files = await repository.get_conversation_files(session, conv.id)
        await session.commit()

    system_prompt = await _build_system_prompt(
        user_data.first_name or "User", lang, bot, timezone_offset
    )
    ai_messages, _ = await _build_ai_messages(
        db_messages,
        conv_files,
        system_prompt,
        bot,
    )

    await bot.send_chat_action(chat_id, "typing", message_thread_id=thread_id)

    result = await generate_and_stream_response(
        bot, chat_id, thread_id, ai_messages, show_thinking, lang
    )

    async with repository.session_factory() as session:
        conv = await repository.get_or_create_conversation(session, user.id, chat_id, thread_id)
        await repository.add_message(
            session, conv.id, "assistant", result.content, message_id=result.first_message_id
        )
        await session.commit()


@router.message(ApprovedUserFilter(), F.text & ~F.text.startswith("/") | F.photo | F.document)
async def handle_message(message: Message, bot: Bot) -> None:
    """Handle an incoming message."""
    if not message.from_user:
        return

    if message.media_group_id and message.photo:
        await _queue_media_group(message, bot)
        return

    chat_id = message.chat.id
    user_data = message.from_user
    thread_id = message.message_thread_id

    text = message.text or message.caption or ""
    image_ids = [message.photo[-1].file_id] if message.photo else []
    await _handle_incoming_payload(
        bot=bot,
        chat_id=chat_id,
        thread_id=thread_id,
        user_data=user_data,
        text=text,
        image_ids=image_ids,
        document=message.document,
        message_id=message.message_id,
    )
