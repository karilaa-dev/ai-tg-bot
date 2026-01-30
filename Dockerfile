FROM python:3.14-slim AS builder

WORKDIR /app
RUN pip install uv

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY . .
RUN uv sync --frozen --no-dev

FROM python:3.14-slim

WORKDIR /app
COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app/bot ./bot
COPY --from=builder /app/main.py .

ENV PATH="/app/.venv/bin:$PATH"

CMD ["python", "main.py"]
