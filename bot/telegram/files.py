"""File download and base64 encoding utilities for Telegram."""

import base64
import io
import logging

from aiogram import Bot

logger = logging.getLogger(__name__)

MIME_TYPES = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "gif": "image/gif",
    "webp": "image/webp",
}


async def _download_file(file_id: str, bot: Bot) -> tuple[bytes, str] | None:
    """Download a file from Telegram and return bytes with file path."""
    try:
        file = await bot.get_file(file_id)
        if not file.file_path:
            logger.error(f"No file path returned for file_id: {file_id}")
            return None

        buffer = io.BytesIO()
        await bot.download_file(file.file_path, destination=buffer)
        buffer.seek(0)
        return buffer.read(), file.file_path
    except Exception as e:
        logger.error(f"Failed to download file: {e}")
        return None


async def download_and_encode_image(file_id: str, bot: Bot) -> str | None:
    """Download an image from Telegram and encode it as base64 data URL."""
    result = await _download_file(file_id, bot)
    if not result:
        return None

    file_data, file_path = result
    extension = file_path.split(".")[-1].lower()
    mime_type = MIME_TYPES.get(extension, "image/jpeg")
    base64_data = base64.b64encode(file_data).decode("utf-8")
    return f"data:{mime_type};base64,{base64_data}"


async def download_and_encode_pdf(file_id: str, bot: Bot) -> tuple[str, str] | None:
    """Download a PDF from Telegram and encode it as base64 data URL.

    Returns:
        Tuple of (base64 data URL, filename) or None if download fails
    """
    result = await _download_file(file_id, bot)
    if not result:
        return None

    file_data, file_path = result
    filename = file_path.split("/")[-1]
    if not filename.endswith(".pdf"):
        filename = "document.pdf"

    base64_data = base64.b64encode(file_data).decode("utf-8")
    data_url = f"data:application/pdf;base64,{base64_data}"
    return data_url, filename
