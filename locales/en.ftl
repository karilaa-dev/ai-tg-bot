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
image-delivery-failed = I couldn't send the generated image. Please try again.
file-delivery-failed = I couldn't send the created file. Please try again.
thinking-summary-running = 🧠 Thinking for { $time }
thinking-summary-generating-image = 🖼️ Generating image for { $time }
thinking-summary-final = 🧠 Thought for { $time }
thinking-final-tool-calls = Tool calls: { $count }
thinking-final-reasoning = Reasoning blocks: { $count }
thinking-final-tools = Tools:
thinking-final-files = Files prepared: { $count }
thinking-final-files-capped = Files prepared: { $sent } of { $requested } (limit { $limit })
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
file-processing-stopping = 🛑 Stopping file processing...
file-processing-cancelled = 🛑 File processing cancelled.
audio-transcribing = Transcribing <code>{ $name }</code>...
audio-no-speech = I could not recognize any speech in this audio. Please record it again or send your prompt as text.
audio-transcription-failed = I could not transcribe this audio. Please try again or send your prompt as text.
audio-transcription-rate-limited = Audio transcription is temporarily rate-limited. Please try again shortly or send your prompt as text.
stop-none = ℹ️ No active task in this thread.
turn-stopping = 🛑 Stopping the active agent turn...
turn-pending-cancelled = 🛑 Pending message cancelled.
file-processed = ✅ File <code>{ $name }</code> processed.
file-source-registered = ✅ File <code>{ $name }</code> registered for sandbox inspection.
file-reused = ♻️ Reused saved file <code>{ $name }</code>.
fork-created = 🌱 Fork created. Context was carried into the new topic.
fork-need-topics = 🧵 Topics are not enabled for this bot. Enable Topics in BotFather first.
help = 🧭 Commands: /lang, /timezone, /stream, /stop, /fork, /compact, /help. Start a new Telegram topic for a clean thread; use /fork to carry Pi context into a new topic. Use /stop to cancel the active agent turn or file processing.
private-only = 🔒 I only work in private chats.
unknown-command = ❓ Unknown command. Try /help.
