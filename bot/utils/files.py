"""File download and base64 encoding utilities for Telegram."""

import base64
import logging
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from bot.handlers.telegram import TelegramClient

logger = logging.getLogger(__name__)

MIME_TYPES = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "gif": "image/gif",
    "webp": "image/webp",
}


async def _download_file(file_id: str, client: "TelegramClient") -> tuple[bytes, str] | None:
    """Download a file from Telegram and return bytes with file path."""
    file_info = await client.get_file(file_id)
    if not file_info.get("ok"):
        logger.error(f"Failed to get file info: {file_info}")
        return None

    file_path = file_info["result"]["file_path"]
    file_data = await client.download_file(file_path)
    return file_data, file_path


async def download_and_encode_image(file_id: str, client: "TelegramClient") -> str | None:
    """Download an image from Telegram and encode it as base64 data URL."""
    result = await _download_file(file_id, client)
    if not result:
        return None

    file_data, file_path = result
    extension = file_path.split(".")[-1].lower()
    mime_type = MIME_TYPES.get(extension, "image/jpeg")
    base64_data = base64.b64encode(file_data).decode("utf-8")
    return f"data:{mime_type};base64,{base64_data}"


async def download_and_encode_pdf(file_id: str, client: "TelegramClient") -> tuple[str, str] | None:
    """Download a PDF from Telegram and encode it as base64 data URL.

    Returns:
        Tuple of (base64 data URL, filename) or None if download fails
    """
    result = await _download_file(file_id, client)
    if not result:
        return None

    file_data, file_path = result
    filename = file_path.split("/")[-1]
    if not filename.endswith(".pdf"):
        filename = "document.pdf"

    base64_data = base64.b64encode(file_data).decode("utf-8")
    data_url = f"data:application/pdf;base64,{base64_data}"
    return data_url, filename
