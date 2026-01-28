"""Token counting utilities using tiktoken."""

import logging
from typing import Any

import tiktoken

from bot.config import settings

logger = logging.getLogger(__name__)

_encoding: tiktoken.Encoding | None = None


def get_encoding() -> tiktoken.Encoding:
    """Get or create tiktoken encoding (cached)."""
    global _encoding
    if _encoding is None:
        _encoding = tiktoken.get_encoding("cl100k_base")
    return _encoding


def count_tokens(text: str) -> int:
    """Count tokens in a text string.

    Args:
        text: Text to count tokens for

    Returns:
        Number of tokens
    """
    encoding = get_encoding()
    return len(encoding.encode(text))


def count_message_tokens(message: dict[str, Any]) -> int:
    """Count tokens in a message.

    Args:
        message: Message dict with role and content

    Returns:
        Approximate token count for the message
    """
    tokens = 4

    content = message.get("content", "")
    if isinstance(content, str):
        tokens += count_tokens(content)
    elif isinstance(content, list):
        for item in content:
            if isinstance(item, dict):
                if item.get("type") == "text":
                    tokens += count_tokens(item.get("text", ""))
                elif item.get("type") in ("image_url", "file"):
                    tokens += 85

    tokens += count_tokens(message.get("role", ""))

    return tokens


def trim_messages_to_limit(
    messages: list[dict[str, Any]],
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """Trim messages to fit within token limit, keeping most recent.

    Args:
        messages: List of message dicts
        limit: Token limit (defaults to settings.context_token_limit)

    Returns:
        Trimmed list of messages within the token limit
    """
    if limit is None:
        limit = settings.context_token_limit

    if not messages:
        return []

    total_tokens = sum(count_message_tokens(msg) for msg in messages)

    if total_tokens <= limit:
        return messages

    result = []
    current_tokens = 0

    for msg in reversed(messages):
        msg_tokens = count_message_tokens(msg)
        if current_tokens + msg_tokens > limit:
            break
        result.insert(0, msg)
        current_tokens += msg_tokens

    logger.debug(f"Trimmed messages from {len(messages)} to {len(result)} ({current_tokens} tokens)")
    return result
