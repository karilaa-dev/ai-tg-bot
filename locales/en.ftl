start-welcome =
    # 👋 Welcome to your AI assistant

    ## What I can help with
    - 🔎 *Search*: find current information, verify facts with sources, summarize web results
    - 🎨 *Images*: generate new images, edit or transform existing images, refine visual prompts
    - 💻 *Code*: run scripts and calculations, debug errors, analyze data or files
    - 📎 *Files*: read uploaded documents, create reports or tables, send generated files back here
    _Send a message or upload a file to start._ Use /help for commands.
lang-pick = 🌐 Choose a language. Auto-picked: { $lang }.
lang-auto-note = 🌐 Language was selected from your Telegram profile.
lang-set = ✅ Language set to English.
tz-ask =
    🕒 *Set timezone*

    What time is it for you right now?
    Example: `14:30` or `2:30 PM`
tz-bad-format =
    ⚠️ *I could not parse that time.*

    Send it like `14:30` or `2:30 PM`.
tz-set =
    ✅ *Timezone saved*

    Offset: `{ $offset }`
    Your current time: `{ $time }`
tz-onboarding-prompt =
    🕒 *Set your timezone*

    This helps me handle dates, reminders, and time-sensitive answers correctly.
tz-onboarding-btn-set = 🕒 Set timezone
tz-onboarding-btn-later = Later
tz-onboarding-btn-moscow = Moscow UTC+03:00
tz-moscow-label = Moscow
tz-onboarding-later =
    No problem. You can set your timezone anytime with /timezone.
tz-direct-set =
    ✅ *Timezone saved*

    Location: *{ $label }*
    Offset: `{ $offset }`
onboarding-ready =
    ✨ *Ready.*

    Send me a task whenever you want.
stream-on = 🌊 Streaming drafts are on.
stream-off = 📴 Streaming drafts are off.
stream-state-on = 🌊 on
stream-state-off = 📴 off
thinking-placeholder = 💭 Thinking...
thinking-done = ✅ Done.
image-generated-done = Done — the image is ready.
image-generated-ready = Done — the image is ready.
thinking-summary-running = 🧠 Thinking for { $time }
thinking-summary-generating-image = 🖼️ Generating image for { $time }
thinking-summary-final = 🧠 Thought for { $time }
thinking-final-tool-calls = Tool calls: { $count }
thinking-final-reasoning = Reasoning blocks: { $count }
thinking-final-tools = Tools:
thinking-final-files = Files sent: { $count }
thinking-final-files-capped = Files sent: { $sent } of { $requested } (limit { $limit })
show-more = 📖 Show more
compacting = 🗜 Compacting memory...
compacted = ✅ Compacted { $count } messages.
busy = ⏳ I am still working in this thread. I saved your message for the next turn.
error-generic = ⚠️ Something went wrong.
empty-answer = ⚠️ I finished the tool work, but no final answer was returned. Please try again, or ask for a smaller section.
file-unsupported = 📎 This file type is not supported.
file-too-big = 📦 This file is too large. Telegram bot downloads are capped at 20 MB.
file-doc-legacy = 📄 Legacy .doc files are not supported. Re-save it as .docx.
processing-file = 📎 Processing file...
file-processing-downloading = 📥 Downloading <code>{ $name }</code>...
file-processing-extracting = 📄 Extracting <code>{ $name }</code>...
file-processing-captioning = 🖼️ Captioning <code>{ $name }</code>...
file-processing-indexing = 🔎 Indexing <code>{ $name }</code>...
    { $percent }%
file-processing-embedding = 🧠 Building vector index for <code>{ $name }</code>...
    { $percent }%
file-processing-stopping = 🛑 Stopping file processing...
file-processing-cancelled = 🛑 File processing cancelled.
stop-none = ℹ️ No active task in this thread.
turn-stopping = 🛑 Stopping the active agent turn...
file-processed = ✅ File <code>{ $name }</code> processed.
file-reused = ♻️ Reused cached file <code>{ $name }</code>.
docling-down = ⚠️ Docling is not reachable. Start it with docker compose up -d docling.
fork-created = 🌱 Fork created. Context was carried into the new topic.
fork-need-topics = 🧵 Topics are not enabled for this bot. Enable Topics in BotFather first.
help = 🧭 Commands: /lang, /timezone, /stream, /stop, /fork, /compact, /help. Start a new Telegram topic for a clean thread; use /fork to carry Pi context into a new topic. Use /stop to cancel the active agent turn or file processing.
private-only = 🔒 I only work in private chats.
unknown-command = ❓ Unknown command. Try /help.
