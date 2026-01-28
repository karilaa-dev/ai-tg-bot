"""PDF download and base64 encoding utilities."""

import base64
import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from bot.handlers.telegram import TelegramClient

logger = logging.getLogger(__name__)


async def download_and_encode_pdf(
    file_id: str,
    client: "TelegramClient",
) -> tuple[str, str] | None:
    """Download a PDF from Telegram and encode it as base64 data URL.

    Args:
        file_id: Telegram file_id for the PDF
        client: Telegram client instance

    Returns:
        Tuple of (base64 data URL, filename) or None if download fails
    """
    try:
        file_info = await client.get_file(file_id)

        if not file_info.get("ok"):
            logger.error(f"Failed to get file info: {file_info}")
            return None

        file_path = file_info["result"]["file_path"]
        file_data = await client.download_file(file_path)

        filename = file_path.split("/")[-1]
        if not filename.endswith(".pdf"):
            filename = "document.pdf"

        base64_data = base64.b64encode(file_data).decode("utf-8")
        data_url = f"data:application/pdf;base64,{base64_data}"

        return data_url, filename

    except Exception as e:
        logger.error(f"Error downloading/encoding PDF: {e}")
        return None
