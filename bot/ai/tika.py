"""Apache Tika PDF parsing client."""

import logging

import httpx

from bot.config import settings

logger = logging.getLogger(__name__)


async def extract_pdf_text(pdf_bytes: bytes) -> str:
    """Extract text from PDF bytes using Apache Tika."""
    if not pdf_bytes:
        raise ValueError("PDF content is empty")

    url = f"{settings.tika_url.rstrip('/')}/tika"
    headers = {
        "Accept": "text/plain",
        "Content-Type": "application/pdf",
    }
    auth: tuple[str, str] | None = None

    if settings.tika_token:
        headers["Authorization"] = f"Bearer {settings.tika_token}"
    elif settings.tika_username and settings.tika_password:
        auth = (settings.tika_username, settings.tika_password)

    timeout = httpx.Timeout(settings.tika_timeout_seconds)

    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.put(url, content=pdf_bytes, headers=headers, auth=auth)

    if response.status_code != 200:
        logger.error("Tika parse failed: %s %s", response.status_code, response.text)
        raise RuntimeError("Tika parse failed")

    return response.text
