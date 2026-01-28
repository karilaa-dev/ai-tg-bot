"""Image download and base64 encoding utilities."""

import base64
import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from bot.handlers.telegram import TelegramClient

logger = logging.getLogger(__name__)


async def download_and_encode_image(
    file_id: str,
    client: "TelegramClient",
) -> str | None:
    """Download an image from Telegram and encode it as base64 data URL.

    Args:
        file_id: Telegram file_id for the image
        client: Telegram client instance

    Returns:
        Base64 data URL string or None if download fails
    """
    try:
        file_info = await client.get_file(file_id)

        if not file_info.get("ok"):
            logger.error(f"Failed to get file info: {file_info}")
            return None

        file_path = file_info["result"]["file_path"]
        file_data = await client.download_file(file_path)

        extension = file_path.split(".")[-1].lower()
        mime_types = {
            "jpg": "image/jpeg",
            "jpeg": "image/jpeg",
            "png": "image/png",
            "gif": "image/gif",
            "webp": "image/webp",
        }
        mime_type = mime_types.get(extension, "image/jpeg")

        base64_data = base64.b64encode(file_data).decode("utf-8")
        return f"data:{mime_type};base64,{base64_data}"

    except Exception as e:
        logger.error(f"Error downloading/encoding image: {e}")
        return None
