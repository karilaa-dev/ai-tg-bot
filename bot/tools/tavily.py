"""Tavily search and extract client."""

import logging
from typing import Any

from tavily import AsyncTavilyClient

from bot.config import settings

logger = logging.getLogger(__name__)


class TavilyClient:
    """Async wrapper for Tavily search and extract APIs."""

    def __init__(self) -> None:
        self.client = AsyncTavilyClient(api_key=settings.tavily_api_key)

    async def search(
        self,
        query: str,
        max_results: int = 5,
        search_depth: str = "basic",
    ) -> dict[str, Any]:
        """Search the web using Tavily.

        Args:
            query: Search query
            max_results: Maximum number of results
            search_depth: "basic" or "advanced"

        Returns:
            Search results with title, url, and content snippets
        """
        try:
            result = await self.client.search(
                query=query,
                max_results=max_results,
                search_depth=search_depth,
            )
            return {
                "query": query,
                "results": [
                    {
                        "title": r.get("title", ""),
                        "url": r.get("url", ""),
                        "content": r.get("content", ""),
                    }
                    for r in result.get("results", [])
                ],
            }
        except Exception as e:
            logger.error(f"Tavily search error: {e}")
            return {"query": query, "error": str(e), "results": []}

    async def extract(self, url: str) -> dict[str, Any]:
        """Extract content from a webpage URL.

        Args:
            url: URL to extract content from

        Returns:
            Extracted content from the webpage
        """
        try:
            result = await self.client.extract(urls=[url])
            results = result.get("results", [])
            if results:
                return {
                    "url": url,
                    "content": results[0].get("raw_content", ""),
                }
            return {"url": url, "content": "", "error": "No content extracted"}
        except Exception as e:
            logger.error(f"Tavily extract error: {e}")
            return {"url": url, "error": str(e)}


tavily_client = TavilyClient()
