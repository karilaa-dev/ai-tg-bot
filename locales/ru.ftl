start-welcome =
    # 👋 Добро пожаловать в AI-ассистента

    ## С чем я могу помочь
    - 🔎 *Поиск*: находить актуальную информацию, проверять факты по источникам, кратко пересказывать результаты
    - 🎨 *Изображения*: генерировать новые изображения, редактировать стиль, улучшать визуальные промпты
    - 💻 *Код*: запускать скрипты и расчеты, разбирать ошибки, анализировать данные или файлы
    - 📎 *Файлы*: читать документы, создавать отчеты или таблицы, отправлять готовые файлы сюда
    _Напишите сообщение или загрузите файл, чтобы начать._ Команды доступны через /help.
lang-pick = 🌐 Выберите язык. Автоматически выбран: { $lang }.
lang-auto-note = 🌐 Язык выбран по профилю Telegram.
lang-set = ✅ Язык переключен на русский.
tz-ask =
    🕒 *Установка часового пояса*

    Который у вас сейчас час?
    Например: `14:30` или `2:30 PM`
tz-bad-format =
    ⚠️ *Не получилось разобрать время.*

    Отправьте в формате `14:30` или `2:30 PM`.
tz-set =
    ✅ *Часовой пояс сохранен*

    Смещение: `{ $offset }`
    Ваше текущее время: `{ $time }`
tz-onboarding-prompt =
    🕒 *Установите часовой пояс*

    Так я буду корректно работать с датами, напоминаниями и ответами, где важно время.
tz-onboarding-btn-set = 🕒 Установить часовой пояс
tz-onboarding-btn-later = Позже
tz-onboarding-btn-moscow = Москва UTC+03:00
tz-moscow-label = Москва
tz-onboarding-later =
    Хорошо. Вы можете установить часовой пояс в любой момент командой /timezone.
tz-direct-set =
    ✅ *Часовой пояс сохранен*

    Место: *{ $label }*
    Смещение: `{ $offset }`
onboarding-ready =
    ✨ *Готово.*

    Можете отправлять задачу.
stream-on = 🌊 Потоковые черновики включены.
stream-off = 📴 Потоковые черновики выключены.
stream-state-on = 🌊 вкл
stream-state-off = 📴 выкл
thinking-placeholder = 💭 Думаю...
thinking-done = ✅ Готово.
image-delivery-failed = Не удалось отправить созданное изображение. Попробуйте ещё раз.
file-delivery-failed = Не удалось отправить созданный файл. Попробуйте ещё раз.
thinking-summary-running = 🧠 Думаю уже { $time }
thinking-summary-generating-image = 🖼️ Генерирую изображение уже { $time }
thinking-summary-final = 🧠 Думал { $time }
thinking-final-tool-calls = Вызовы инструментов: { $count }
thinking-final-reasoning = Блоков рассуждений: { $count }
thinking-final-tools = Инструменты:
thinking-final-files = Подготовлено файлов: { $count }
thinking-final-files-capped = Подготовлено файлов: { $sent } из { $requested } (лимит { $limit })
compacting = 🗜 Сжимаю память...
compacted = ✅ Сжато сообщений: { $count }.
busy = ⏳ Я еще работаю в этой теме. Сообщение сохранено для следующего хода.
error-generic = ⚠️ Что-то пошло не так.
empty-answer = ⚠️ Работа с инструментами завершилась, но итоговый ответ не вернулся. Попробуйте еще раз или попросите меньший раздел.
file-unsupported = 📎 Этот тип файла не поддерживается.
file-too-big = 📦 Файл слишком большой. Лимит загрузки для ботов Telegram - 20 МБ.
file-doc-legacy = 📄 Файлы .doc не поддерживаются. Сохраните файл как .docx.
processing-file = 📎 Обрабатываю файл...
file-processing-downloading = 📥 Загружаю <code>{ $name }</code>...
file-processing-extracting = 📄 Извлекаю данные из <code>{ $name }</code>...
file-processing-captioning = 🖼️ Описываю <code>{ $name }</code>...
file-processing-indexing = 🔎 Индексирую <code>{ $name }</code>...
    { $percent }%
file-processing-stopping = 🛑 Останавливаю обработку файла...
file-processing-cancelled = 🛑 Обработка файла отменена.
audio-transcribing = 🎙️ Расшифровываю...
audio-download-failed = Не удалось скачать аудио. Попробуйте ещё раз.
audio-no-speech = Не удалось распознать речь в этом аудио. Запишите его ещё раз или отправьте запрос текстом.
audio-transcription-failed = Не удалось расшифровать аудио. Попробуйте ещё раз или отправьте запрос текстом.
audio-transcription-rate-limited = Сервис расшифровки аудио временно ограничил запросы. Попробуйте чуть позже или отправьте запрос текстом.
stop-none = ℹ️ В этом треде нет активной задачи.
turn-stopping = 🛑 Останавливаю активный ход агента...
turn-pending-cancelled = 🛑 Отложенное сообщение отменено.
file-processed = ✅ Файл <code>{ $name }</code> обработан.
file-source-registered = ✅ Файл <code>{ $name }</code> зарегистрирован для анализа в песочнице.
file-reused = ♻️ Использую сохраненный файл <code>{ $name }</code>.
fork-created = 🌱 Форк создан. Контекст перенесен в новую тему.
fork-need-topics = 🧵 Темы не включены для этого бота. Сначала включите Topics в BotFather.
help = 🧭 Команды: /lang, /timezone, /stream, /stop, /fork, /compact, /help. Для чистого треда начните новую тему Telegram; /fork переносит контекст Pi в новую тему. /stop отменяет активный ход агента или обработку файла.
private-only = 🔒 Я работаю только в личных чатах.
unknown-command = ❓ Неизвестная команда. Попробуйте /help.
