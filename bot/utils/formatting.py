"""Text formatting utilities for Telegram."""

import random
import string
import time

import telegramify_markdown

SAFE_MESSAGE_LENGTH = 3900


def _escape_markdown_v2_full(text: str) -> str:
    """Escape ALL special characters for MarkdownV2 (for thinking block)."""
    text = text.replace("\\", "\\\\")
    for char in "_*[]()~`>#+-=|{}.!":
        text = text.replace(char, f"\\{char}")
    return text


def convert_to_telegram_markdown(text: str) -> str:
    """Convert standard Markdown to Telegram MarkdownV2 format."""
    return telegramify_markdown.markdownify(text)


def format_thinking_expanded(thinking: str) -> str:
    """Format thinking as expanded blockquote for MarkdownV2 (visible while streaming).

    Uses standard blockquote format (>line) which displays fully expanded.
    """
    if not thinking:
        return ""

    escaped = _escape_markdown_v2_full(thinking)
    lines = escaped.split("\n")
    return "\n".join(f">{line}" for line in lines)


def format_thinking_collapsed(thinking: str) -> str:
    """Format thinking as collapsed/expandable blockquote for MarkdownV2.

    Telegram expandable blockquotes use **> for the first line, > for middle lines,
    and || to close the expandable section. Collapsed by default.
    """
    if not thinking:
        return ""

    escaped = _escape_markdown_v2_full(thinking)
    lines = escaped.split("\n")

    # Build expandable blockquote: **>first line, >middle lines, last line||
    quoted_lines = [f"**>{lines[0]}"]
    quoted_lines.extend(f">{line}" for line in lines[1:])
    quoted_lines[-1] += "||"
    return "\n".join(quoted_lines)


def format_thinking_with_content(thinking: str, content: str) -> str:
    """Combine collapsed thinking block with content for final message.

    Returns MarkdownV2 formatted string with collapsed thinking + separator + content.
    """
    if not thinking:
        return convert_to_telegram_markdown(content)

    thinking_block = format_thinking_collapsed(thinking)
    content_formatted = convert_to_telegram_markdown(content)
    return f"{thinking_block}\n\n{content_formatted}"


def split_thinking(thinking: str, max_length: int) -> tuple[str, str]:
    """Split thinking at safe boundary for overflow handling.

    Args:
        thinking: Raw thinking text (unescaped)
        max_length: Maximum length for formatted output

    Returns:
        Tuple of (part_to_send_raw, remaining_raw_text)
    """
    if not thinking:
        return "", ""

    # Estimate raw text length that fits in max_length when formatted
    # Collapsed format adds ~4 chars overhead (**>, ||) plus escaping (~20% overhead)
    estimated_raw_limit = int(max_length * 0.8) - 10

    if len(thinking) <= estimated_raw_limit:
        return thinking, ""

    # Find a good split point in raw text
    split_pos = find_split_point(thinking, estimated_raw_limit)
    return thinking[:split_pos].rstrip(), thinking[split_pos:].lstrip()


def find_split_point(text: str, max_length: int) -> int:
    """Find a good point to split text, preferring natural boundaries.

    Searches for paragraph breaks, line breaks, sentence ends, then word breaks.
    Returns max_length if no suitable boundary is found.
    """
    chunk = text[:max_length]
    for sep in ["\n\n", "\n", ". ", " "]:
        pos = chunk.rfind(sep)
        if pos > max_length // 3:
            return pos + len(sep)
    return max_length


def split_message(text: str, max_length: int = SAFE_MESSAGE_LENGTH) -> list[str]:
    """Split text into chunks at safe boundaries."""
    if len(text) <= max_length:
        return [text]

    parts = []
    remaining = text

    while remaining:
        if len(remaining) <= max_length:
            parts.append(remaining)
            break

        split_pos = find_split_point(remaining, max_length)
        parts.append(remaining[:split_pos].rstrip())
        remaining = remaining[split_pos:].lstrip()

    return parts


def generate_draft_id() -> int:
    """Generate a unique draft ID for Telegram message drafts."""
    return int(time.time() * 1000) % (2**31 - 1)


def generate_invite_code() -> str:
    """Generate a random 8-character alphanumeric invite code."""
    chars = string.ascii_lowercase + string.digits
    return "".join(random.choices(chars, k=8))


def format_timezone_offset(offset_minutes: int) -> str:
    """Format timezone offset as UTC+X or UTC-X string."""
    if offset_minutes == 0:
        return "UTC"

    sign = "+" if offset_minutes > 0 else "-"
    abs_minutes = abs(offset_minutes)
    hours = abs_minutes // 60
    minutes = abs_minutes % 60

    if minutes == 0:
        return f"UTC{sign}{hours}"
    return f"UTC{sign}{hours}:{minutes:02d}"
