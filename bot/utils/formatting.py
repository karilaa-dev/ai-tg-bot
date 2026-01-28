"""Text formatting utilities for Telegram."""

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


def format_thinking_block(thinking: str) -> str:
    """Format thinking as collapsed/expandable blockquote for MarkdownV2.

    Telegram expandable blockquotes use **> for the first line, > for middle lines,
    and || to close the expandable section.
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
