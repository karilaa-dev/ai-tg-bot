"""OpenRouter API client using OpenAI SDK."""

import json
import logging
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from typing import Any

from openai import AsyncOpenAI
from tavily import AsyncTavilyClient

from bot.config import settings

logger = logging.getLogger(__name__)

# Tool definitions for function calling
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web for current information. Use this when you need up-to-date information about events, news, or topics.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query to find relevant information",
                    }
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "extract_webpage",
            "description": "Extract and read the full content from a webpage URL. Use this when you need to read the content of a specific webpage.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The URL of the webpage to extract content from",
                    }
                },
                "required": ["url"],
            },
        },
    },
]


@dataclass
class StreamChunk:
    """A chunk of streaming response."""
    content: str = ""
    reasoning: str = ""
    is_tool_use: bool = False
    tool_name: str = ""


_tavily: AsyncTavilyClient | None = None


def _get_tavily() -> AsyncTavilyClient:
    """Get or create Tavily client (lazy initialization)."""
    global _tavily
    if _tavily is None:
        _tavily = AsyncTavilyClient(api_key=settings.tavily_api_key)
    return _tavily


async def _execute_tool(name: str, args: dict[str, Any]) -> str:
    """Execute a tool and return JSON result."""
    tavily = _get_tavily()
    if name == "web_search":
        result = await tavily.search(
            query=args["query"],
            max_results=5,
            search_depth="basic",
        )
        formatted = {
            "query": args["query"],
            "results": [
                {"title": r.get("title", ""), "url": r.get("url", ""), "content": r.get("content", "")}
                for r in result.get("results", [])
            ],
        }
        return json.dumps(formatted, ensure_ascii=False)
    elif name == "extract_webpage":
        result = await tavily.extract(urls=[args["url"]])
        results = result.get("results", [])
        if results:
            formatted = {"url": args["url"], "content": results[0].get("raw_content", "")}
        else:
            formatted = {"url": args["url"], "content": "", "error": "No content extracted"}
        return json.dumps(formatted, ensure_ascii=False)
    else:
        return json.dumps({"error": f"Unknown tool: {name}"})


class OpenRouterClient:
    """Async OpenRouter client with streaming and tool support."""

    def __init__(self) -> None:
        self.client = AsyncOpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=settings.openrouter_api_key,
        )
        self.model = settings.openrouter_model

    async def generate_response_stream(
        self, messages: list[dict[str, Any]], show_thinking: bool = False
    ) -> AsyncGenerator[StreamChunk, None]:
        """Stream response, handling tool calls internally."""
        current_messages = list(messages)

        iteration = 0
        while True:
            logger.debug(f"Iteration {iteration}, messages: {len(current_messages)}")
            try:
                response = await self.client.chat.completions.create(
                    model=self.model, messages=current_messages, tools=TOOLS, stream=True
                )
            except Exception as e:
                logger.error(f"API error: {e}")
                yield StreamChunk(content=f"\nAPI error: {e}")
                return

            content, reasoning = "", ""
            tool_calls: list[dict[str, Any]] = []

            try:
                async for chunk in response:
                    if not chunk.choices:
                        continue

                    delta = chunk.choices[0].delta

                    # Reasoning from model_extra
                    if show_thinking and hasattr(delta, "model_extra") and delta.model_extra:
                        if r := delta.model_extra.get("reasoning"):
                            reasoning += r
                            yield StreamChunk(reasoning=r)

                    # Content
                    if delta and delta.content:
                        content += delta.content
                        yield StreamChunk(content=delta.content)

                    # Tool calls
                    if delta and delta.tool_calls:
                        for tc in delta.tool_calls:
                            idx = tc.index or 0
                            while len(tool_calls) <= idx:
                                tool_calls.append({"id": "", "type": "function", "function": {"name": "", "arguments": ""}})
                            if tc.id:
                                tool_calls[idx]["id"] = tc.id
                            if tc.function:
                                if tc.function.name:
                                    tool_calls[idx]["function"]["name"] = tc.function.name
                                if tc.function.arguments:
                                    tool_calls[idx]["function"]["arguments"] += tc.function.arguments

            except Exception as e:
                logger.error(f"Stream error: {e}")
                yield StreamChunk(content=f"\nStream error: {e}")
                return

            logger.debug(f"Iteration {iteration} done: content={len(content)} chars, tools={len(tool_calls)}")

            if not tool_calls:
                return

            iteration += 1

            # Execute tools - include reasoning_content when thinking is enabled
            assistant_msg: dict[str, Any] = {
                "role": "assistant",
                "content": content or None,
                "tool_calls": tool_calls,
            }
            if reasoning:
                assistant_msg["reasoning_content"] = reasoning
            current_messages.append(assistant_msg)

            for tc in tool_calls:
                name = tc["function"]["name"]
                logger.info(f"Tool: {name}")
                yield StreamChunk(is_tool_use=True, tool_name=name)

                args = json.loads(tc["function"]["arguments"]) if tc["function"]["arguments"] else {}
                result = await _execute_tool(name, args)
                current_messages.append({"role": "tool", "tool_call_id": tc["id"], "content": result})


openrouter_client = OpenRouterClient()
