# AI Telegram Bot

An AI-powered Telegram bot with streaming responses, tool support (web search and webpage extraction), conversation persistence, and optional thinking traces.

## Codebase Overview

**Stack**: Python 3.12+, aiogram 3.24+, OpenAI SDK (via OpenRouter), SQLAlchemy 2.0, Tavily, Telegram Bot API 9.3

**Structure**:
- `main.py` - Entry point, starts aiogram polling
- `bot/ai/` - OpenRouter client with streaming, tool calling, and Tavily integration
- `bot/database/` - SQLAlchemy models and repository
- `bot/telegram/` - aiogram Bot, Dispatcher, and handlers
- `bot/utils/` - Formatting, token counting

For detailed architecture, see [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md).

## Key Commands

```bash
# Run the bot
python main.py

# Install dependencies
uv sync
```

## Environment Variables

Required in `.env`:
- `TELEGRAM_BOT_TOKEN` - Bot token from @BotFather
- `OPENROUTER_API_KEY` - API key from OpenRouter
- `TAVILY_API_KEY` - API key from Tavily

Optional:
- `OPENROUTER_MODEL` - Model ID (default: moonshotai/kimi-k2.5)
- `DATABASE_URL` - SQLAlchemy URL (default: sqlite+aiosqlite:///./bot.db)
- `CONTEXT_TOKEN_LIMIT` - Max context tokens (default: 8000)

## Architecture Notes

- All I/O is async (aiogram, aiosqlite, async OpenAI client)
- Singleton pattern for all clients (`bot`, `dp`, `openrouter_client`, `repository`)
- Streaming responses with Telegram draft messages (Bot API 9.3)
- Token-aware context window management
- Multimodal support (images, PDFs converted to base64)
- aiogram routers for handler organization
