"""Telegram API client using aiohttp."""

import logging
from typing import Any

import aiohttp

from bot.config import settings

logger = logging.getLogger(__name__)


class TelegramClient:
    """Async Telegram Bot API client."""

    def __init__(self) -> None:
        self.token = settings.telegram_bot_token
        self.base_url = f"https://api.telegram.org/bot{self.token}"
        self.file_url = f"https://api.telegram.org/file/bot{self.token}"
        self._session: aiohttp.ClientSession | None = None

    async def get_session(self) -> aiohttp.ClientSession:
        """Get or create aiohttp session."""
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    async def close(self) -> None:
        """Close the aiohttp session."""
        if self._session and not self._session.closed:
            await self._session.close()

    async def _request(
        self,
        method: str,
        endpoint: str,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Make a request to the Telegram API."""
        session = await self.get_session()
        url = f"{self.base_url}/{endpoint}"

        async with session.request(method, url, **kwargs) as response:
            data = await response.json()
            if not data.get("ok"):
                logger.error(f"Telegram API error: {data}")
            return data

    async def get_updates(
        self,
        offset: int = 0,
        timeout: int = 30,
        allowed_updates: list[str] | None = None,
    ) -> dict[str, Any]:
        """Get updates using long polling."""
        params: dict[str, Any] = {
            "offset": offset,
            "timeout": timeout,
        }
        if allowed_updates:
            params["allowed_updates"] = allowed_updates

        return await self._request("GET", "getUpdates", params=params)

    async def send_message(
        self,
        chat_id: int,
        text: str,
        message_thread_id: int | None = None,
        parse_mode: str | None = None,
        reply_to_message_id: int | None = None,
    ) -> dict[str, Any]:
        """Send a message to a chat."""
        data: dict[str, Any] = {
            "chat_id": chat_id,
            "text": text,
        }
        if message_thread_id:
            data["message_thread_id"] = message_thread_id
        if parse_mode:
            data["parse_mode"] = parse_mode
        if reply_to_message_id:
            data["reply_to_message_id"] = reply_to_message_id

        return await self._request("POST", "sendMessage", json=data)

    async def send_message_draft(
        self,
        chat_id: int,
        draft_id: int,
        text: str,
        message_thread_id: int | None = None,
        parse_mode: str | None = None,
    ) -> dict[str, Any]:
        """Send a message draft for streaming updates (Bot API 9.3)."""
        data: dict[str, Any] = {
            "chat_id": chat_id,
            "draft_id": draft_id,
            "text": text,
        }
        if message_thread_id:
            data["message_thread_id"] = message_thread_id
        if parse_mode:
            data["parse_mode"] = parse_mode

        return await self._request("POST", "sendMessageDraft", json=data)

    async def get_file(self, file_id: str) -> dict[str, Any]:
        """Get file info by file_id."""
        return await self._request("GET", "getFile", params={"file_id": file_id})

    async def download_file(self, file_path: str) -> bytes:
        """Download a file from Telegram servers."""
        session = await self.get_session()
        url = f"{self.file_url}/{file_path}"

        async with session.get(url) as response:
            return await response.read()

    async def send_chat_action(
        self,
        chat_id: int,
        action: str = "typing",
        message_thread_id: int | None = None,
    ) -> dict[str, Any]:
        """Send chat action (typing indicator)."""
        data: dict[str, Any] = {
            "chat_id": chat_id,
            "action": action,
        }
        if message_thread_id:
            data["message_thread_id"] = message_thread_id

        return await self._request("POST", "sendChatAction", json=data)

    async def edit_message_text(
        self,
        chat_id: int,
        message_id: int,
        text: str,
        parse_mode: str | None = None,
    ) -> dict[str, Any]:
        """Edit an existing message's text."""
        data: dict[str, Any] = {
            "chat_id": chat_id,
            "message_id": message_id,
            "text": text,
        }
        if parse_mode:
            data["parse_mode"] = parse_mode

        return await self._request("POST", "editMessageText", json=data)

    async def delete_message(self, chat_id: int, message_id: int) -> dict[str, Any]:
        """Delete a message."""
        data: dict[str, Any] = {
            "chat_id": chat_id,
            "message_id": message_id,
        }
        return await self._request("POST", "deleteMessage", json=data)


telegram_client = TelegramClient()
