# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The owner and a small invited group of family and friends who already use the private Telegram assistant bot. They sign in to the website with their Telegram account to continue the same conversations on a larger screen, attach files, and read richer answers. The owner also uses the separate `/admin` dashboard to inspect users, conversations, usage and cost, and the Codex connection.

## Product Purpose

A personal AI assistant that lives in Telegram and is mirrored on the web. Each conversation has persistent model sessions, a sandbox with tools (shell, files, web search, browser), and long-term memory. The website lets a signed-in user chat, upload any file, stop, fork, or compact a conversation, search their chats with conversation previews, schedule future or recurring checks, manage memories, and change settings. Success means the web chat feels as immediate and trustworthy as a mainstream AI chat app while staying in sync with Telegram.

## Positioning

One assistant, two frontends: every website conversation is also a Telegram topic, and every Telegram chat is readable and continuable on the web, with the same queue, files, memory, language, and settings. Web-created chats can also render structured visual answers (OpenUI) that Telegram cannot show.

## Operating Context

- Users switch between Telegram on a phone and the website on desktop or mobile browsers.
- Replies can take from seconds to minutes because the assistant runs tools; users watch progress (thinking, tool calls) and may stop a reply.
- Sign-in is Telegram OAuth only; the user must already have started the bot.
- The interface supports English and Russian, driven by the same language preference as the bot.

## Capabilities and Constraints

- Built with React, Tailwind, Cloudflare Kumo components, and Tabler icons; bundled by Bun. The user asked to keep Kumo and Tabler, and to keep the Kumo blue accent.
- Attachments accept every file type within the server's size and count limits.
- Read status and unread dots apply only to chats created on the web. The Telegram origin icon identifies chats started in Telegram. Search previews never mark messages read.
- Scheduled checks persist across restarts and run at most once an hour per conversation. Users can manage them through chat or the Scheduled page.
- Admin and user chat are separate apps on the same origin (`/admin` vs `/`).

## Brand Commitments

- Name: AI KaRiLaA. Logo: `assets/logo.jpg`.
- Accent: Kumo brand blue for primary actions and active state (confirmed).
- The chat should follow familiar ChatGPT conventions: assistant prose without a bubble, user messages in a right-aligned bubble, a single collapsible chain for thinking and tool calls with the generation time, and a rounded composer docked at the bottom.

## Evidence on Hand

- Chat preview fixture with sample conversations: `test/web/chat-preview.ts`.
- No marketing claims, testimonials, or public audience; do not invent them.

## Product Principles

1. The conversation is the product; chrome stays quiet and out of the way.
2. Show the assistant's work honestly (steps, duration, failures) without making the user read it.
3. Telegram and web are one conversation; never present them as separate products.
4. Familiar beats clever: standard chat affordances in both languages, on every screen size.
