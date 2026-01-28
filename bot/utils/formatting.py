"""Text formatting utilities for Telegram."""

import re

SAFE_MESSAGE_LENGTH = 3900


def escape_markdown_v2_full(text: str) -> str:
    """Escape ALL special characters for MarkdownV2 (for thinking block)."""
    text = text.replace("\\", "\\\\")
    for char in "_*[]()~`>#+-=|{}.!":
        text = text.replace(char, f"\\{char}")
    return text


def escape_markdown_v2_light(text: str) -> str:
    """Escape only problematic chars, preserving formatting like *bold*, _italic_."""
    # Only escape chars that cause parse errors but aren't used for formatting
    # Keep: * _ ~ for bold, italic, strikethrough
    # Escape: ( ) [ ] as they cause issues outside of proper link syntax
    text = text.replace("\\", "\\\\")
    for char in ".!>#+=-|{}()[]":
        text = text.replace(char, f"\\{char}")
    return text


def escape_markdown_v2_preserve_code(text: str, close_incomplete: bool = False) -> str:
    """Escape MarkdownV2 special chars, preserving code blocks and inline code.

    Args:
        text: The text to escape
        close_incomplete: If True, close any unclosed code blocks/inline code
    """
    result = []
    i = 0
    n = len(text)

    while i < n:
        # Check for code block (```)
        if text[i:i+3] == "```":
            end = text.find("```", i + 3)
            if end != -1:
                result.append(text[i:end + 3])
                i = end + 3
                continue
            else:
                # Unclosed code block
                if close_incomplete:
                    result.append(text[i:] + "\n```")
                else:
                    result.append(text[i:])
                break

        # Check for inline code (`)
        if text[i] == "`":
            end = text.find("`", i + 1)
            if end != -1:
                result.append(text[i:end + 1])
                i = end + 1
                continue
            else:
                # Unclosed inline code
                if close_incomplete:
                    result.append(text[i:] + "`")
                    i = n
                    continue

        # Find next code marker
        next_triple = text.find("```", i)
        next_single = text.find("`", i)

        if next_triple == -1 and next_single == -1:
            result.append(escape_markdown_v2_light(text[i:]))
            break
        elif next_triple == -1:
            end = next_single
        elif next_single == -1:
            end = next_triple
        else:
            end = min(next_triple, next_single)

        result.append(escape_markdown_v2_light(text[i:end]))
        i = end

    return "".join(result)


def format_thinking_block(thinking: str) -> str:
    """Format thinking as collapsed/expandable blockquote for MarkdownV2."""
    if not thinking:
        return ""

    escaped = escape_markdown_v2_full(thinking)
    lines = escaped.split("\n")
    # Expandable blockquote: first line **>, rest >, last ends with ||
    if len(lines) == 1:
        return f"**>{lines[0]}||"

    result = [f"**>{lines[0]}"]
    for line in lines[1:-1]:
        result.append(f">{line}")
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
            # Hard split at max_length
            parts.append(chunk)
            remaining = remaining[max_length:]

    return parts
