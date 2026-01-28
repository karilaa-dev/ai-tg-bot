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
    """Format thinking as collapsed/expandable blockquote for MarkdownV2."""
    if not thinking:
        return ""

    escaped = _escape_markdown_v2_full(thinking)
    lines = escaped.split("\n")

    # Expandable blockquote: first line **>, rest >, last ends with ||
    if len(lines) == 1:
        return f"**>{lines[0]}||"

    result = [f"**>{lines[0]}"]
    result.extend(f">{line}" for line in lines[1:-1])
    result.append(f">{lines[-1]}||")
    return "\n".join(result)


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

        chunk = remaining[:max_length]

        # Find a good split point - prefer paragraph, line, sentence, word
        split_pos = None
        for sep in ["\n\n", "\n", ". ", " "]:
            pos = chunk.rfind(sep)
            if pos > max_length // 3:
                split_pos = pos + len(sep)
                break

        if split_pos:
            parts.append(remaining[:split_pos].rstrip())
            remaining = remaining[split_pos:].lstrip()
        else:
            parts.append(chunk)
            remaining = remaining[max_length:]

    return parts
