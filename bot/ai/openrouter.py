"""OpenRouter API client using OpenAI SDK."""

import json
import logging
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from typing import Any

from openai import AsyncOpenAI

from bot.ai.tools import TOOLS
from bot.config import settings
from bot.tools.tavily import tavily_client

logger = logging.getLogger(__name__)


@dataclass
class StreamChunk:
    """A chunk of streaming response."""
    content: str = ""
    reasoning: str = ""
    is_tool_use: bool = False
    tool_name: str = ""


class OpenRouterClient:
    """Async OpenRouter client with streaming and tool support."""

    def __init__(self) -> None:
        self.client = AsyncOpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=settings.openrouter_api_key,
        )
        self.model = settings.openrouter_model

    async def _execute_tool(self, name: str, args: dict[str, Any]) -> str:
        """Execute a tool and return JSON result."""
        try:
            if name == "web_search":
                result = await tavily_client.search(args["query"])
            elif name == "extract_webpage":
                result = await tavily_client.extract(args["url"])
            else:
                result = {"error": f"Unknown tool: {name}"}
            return json.dumps(result, ensure_ascii=False)
        except Exception as e:
            logger.error(f"Tool error: {e}")
            return json.dumps({"error": str(e)})

    async def generate_response_stream(
        self, messages: list[dict[str, Any]], show_thinking: bool = False
    ) -> AsyncGenerator[StreamChunk, None]:
        """Stream response, handling tool calls internally."""
        current_messages = messages.copy()

        for _ in range(6):  # Max 5 tool rounds + 1 final
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

            if not tool_calls:
                return

            # Execute tools
            current_messages.append({"role": "assistant", "content": content or None, "tool_calls": tool_calls})

            for tc in tool_calls:
                name = tc["function"]["name"]
                logger.info(f"Tool: {name}")
                yield StreamChunk(is_tool_use=True, tool_name=name)

                args = json.loads(tc["function"]["arguments"]) if tc["function"]["arguments"] else {}
                result = await self._execute_tool(name, args)
                current_messages.append({"role": "tool", "tool_call_id": tc["id"], "content": result})


openrouter_client = OpenRouterClient()
