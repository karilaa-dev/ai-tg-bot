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
invite-ask = 🎟️ Send your invite code to continue.
invite-invalid-unknown = ❓ Invite code was not found.
invite-invalid-expired = ⏳ Invite code has expired.
invite-invalid-exhausted = 🚫 Invite code has already been used.
invite-invalid-revoked = 🗑️ Invite code was revoked.
invite-created =
    🎟️ <b>Invite created</b>

    Code: <code>{ $code }</code>
    Uses: <b>{ $uses }</b>
    Expires: <b>{ $expires }</b>

    { $link }
invite-created-toast = 🎟️ Invite created
invite-draft =
    🎟️ Invite settings

    Uses: { $uses }
    Expires: { $expires }

    Adjust with the buttons, then create the invite.
invite-btn-uses = 🔢 Uses { $uses }
invite-btn-exp-7d = 📅 7 days
invite-btn-exp-30d = 📅 30 days
invite-btn-exp-never = ♾️ Never expires
invite-btn-create = ✅ Create invite
invite-btn-open = 🔗 Open invite
invite-btn-revoke = 🗑️ Revoke { $code }
invite-exp-never = ♾️ never
invite-status-active = ✅ active
invite-status-expired = ⏳ expired
invite-status-revoked = 🗑️ revoked
invite-revoked-toast = 🗑️ Invite revoked
invite-revoked = 🗑️ Invite revoked.
invites-empty = 📭 No invites yet.
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
image-generated-done = Done
image-generated-ready = Image generated:
thinking-summary-running = 🧠 Thinking for { $time }
thinking-summary-generating-image = 🖼️ Generating image for { $time }
thinking-summary-final = 🧠 Thought for { $time }
thinking-final-tool-calls = Tool calls: { $count }
thinking-final-reasoning = Reasoning blocks: { $count }
thinking-final-tools = Tools:
thinking-final-files = Files sent: { $count }
thinking-final-files-capped = Files sent: { $sent } of { $requested } (limit { $limit })
show-more = 📖 Show more
ctx-limit = 🧠 This chat is close to the model context limit. Compact memory, or start a new Telegram topic for a clean thread.
btn-compact = 🗜 Compact
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
file-stop-none = ℹ️ No active file processing in this thread.
file-processed = ✅ File <code>{ $name }</code> processed.
file-reused = ♻️ Reused cached file <code>{ $name }</code>.
docling-down = ⚠️ Docling is not reachable. Start it with docker compose up -d docling.
fork-created = 🌱 Fork created. Context was carried into the new topic.
fork-need-topics = 🧵 Topics are not enabled for this bot. Enable Topics in BotFather first.
help = 🧭 Commands: /lang, /timezone, /stream, /stop, /fork, /compact, /help. Start a new Telegram topic for a clean thread; use /fork to carry context into a new topic. Use /stop to cancel active file processing in this thread.
private-only = 🔒 I only work in private chats.
unknown-command = ❓ Unknown command. Try /help.
