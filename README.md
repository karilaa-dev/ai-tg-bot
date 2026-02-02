# AI Telegram Bot

An AI-powered Telegram bot with streaming responses, tool support (web search and webpage extraction), conversation persistence, invite-based access control, and multi-language support.

## Features

- **Streaming Responses**: Real-time AI responses using Telegram's draft messages (Bot API 9.3)
- **Tool Support**: Web search and webpage extraction via Tavily
- **Thinking Mode**: Optional display of AI reasoning traces
- **Conversation Persistence**: SQLite or PostgreSQL database storage
- **Multi-language UI**: English, Russian, and Ukrainian with auto-detection
- **Invite System**: Access control with shareable invite codes
- **Multimodal Input**: Support for images and PDF documents
- **Timezone Support**: Personalized time display based on user timezone

## Commands

### User Commands
| Command | Description |
|---------|-------------|
| `/start` | Start the bot or use an invite code |
| `/help` | Show help message |
| `/lang` | Change interface language |
| `/thinking` | Toggle AI thinking display |
| `/redo` | Regenerate last response |
| `/edit <text>` | Edit last message and regenerate |
| `/code <code>` | Manually enter invite code |
| `/timezone` | Set timezone by entering current time |

### Admin Commands
| Command | Description |
|---------|-------------|
| `/invite [code] [uses]` | Create invite code |
| `/invites` | List all active invite codes |
| `/deleteinvite <code>` | Delete an invite code |
| `/approve <user_id>` | Pre-approve user by Telegram ID |

Admins can also share invite codes via inline mode by typing `@botname` in any chat.

## Quick Start

### Local Development

```bash
# Clone the repository
git clone https://github.com/yourname/ai-tg-bot.git
cd ai-tg-bot

# Create environment file
cp .env.example .env
# Edit .env with your API keys

# Install dependencies (requires uv)
uv sync

# Run the bot
python main.py
```

### Docker

```bash
# Create environment file
cp .env.example .env
# Edit .env with your API keys

# Run with Docker Compose (includes PostgreSQL)
docker compose up -d
```

## Configuration

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from [@BotFather](https://t.me/BotFather) |
| `OPENROUTER_API_KEY` | API key from [OpenRouter](https://openrouter.ai/) |
| `TAVILY_API_KEY` | API key from [Tavily](https://tavily.com/) |
| `ADMIN_IDS` | Comma-separated Telegram user IDs (e.g., `123456789,987654321`) |

### Optional Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENROUTER_MODEL` | `moonshotai/kimi-k2.5` | Model ID from OpenRouter |
| `DATABASE_URL` | `sqlite+aiosqlite:///bot.db` | Database connection URL |
| `CONTEXT_TOKEN_LIMIT` | `8000` | Maximum tokens in conversation context |

### Database Options

**SQLite** (default, local development):
```
DATABASE_URL=sqlite+aiosqlite:///bot.db
```

**PostgreSQL** (recommended for production):
```
DATABASE_URL=postgresql+asyncpg://user:password@localhost:5432/dbname
```

## Architecture

```
ai-tg-bot/
├── main.py                 # Entry point
├── bot/
│   ├── config.py           # Configuration
│   ├── ai/                 # OpenRouter + Tavily client
│   ├── database/           # SQLAlchemy models and repository
│   ├── i18n/               # Translations
│   ├── telegram/           # Bot, handlers, and filters
│   └── utils/              # Formatting and token utilities
├── docs/
│   └── CODEBASE_MAP.md     # Detailed architecture documentation
└── SYS_PROMPT.md           # AI system prompt template
```

See [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md) for detailed architecture documentation.

## Access Control

The bot uses an invite-based access control system:

1. **Admins** (listed in `ADMIN_IDS`) have full access automatically
2. **New users** need an invite code to access the bot
3. Admins can create invite codes via `/invite` command or inline mode
4. Admins can pre-approve users via `/approve <user_id>`

### Sharing Invite Codes

**Via command**:
```
/invite mycode 5    # Creates "mycode" with 5 uses
/invite             # Creates random code with 1 use
```

**Via inline mode**: Type `@yourbotname` in any chat to share invite codes with a button.

**Via deep link**: Share `https://t.me/yourbotname?start=CODE`

## Development

### Requirements

- Python 3.12+
- [uv](https://github.com/astral-sh/uv) package manager

### Dependencies

- `aiogram` - Telegram Bot API framework
- `openai` - OpenAI SDK (for OpenRouter)
- `sqlalchemy` + `aiosqlite`/`asyncpg` - Async database ORM
- `tavily-python` - Web search and extraction
- `tiktoken` - Token counting
- `pydantic-settings` - Configuration management
- `telegramify-markdown` - Markdown conversion

### Adding a New Command

1. Add translation keys to `bot/i18n/translations.py`
2. Add command key to `USER_COMMAND_KEYS` or `ADMIN_COMMAND_KEYS` in `main.py`
3. Create handler in `bot/telegram/handlers/`

### Adding a New AI Tool

1. Add tool definition to `TOOLS` in `bot/ai/openrouter.py`
2. Add execution logic to `_execute_tool()`
3. Add status translation keys to `bot/i18n/translations.py`

## Docker Deployment

The project includes multi-platform Docker images (amd64/arm64) published to GitHub Container Registry.

```bash
# Pull and run
docker pull ghcr.io/yourname/ai-tg-bot:latest
docker run --env-file .env ghcr.io/yourname/ai-tg-bot:latest

# Or use docker-compose with PostgreSQL
docker compose up -d
```

## License

MIT
