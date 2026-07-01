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
invite-ask = 🎟️ Отправьте инвайт-код, чтобы продолжить.
invite-invalid-unknown = ❓ Инвайт-код не найден.
invite-invalid-expired = ⏳ Инвайт-код истек.
invite-invalid-exhausted = 🚫 Инвайт-код уже использован.
invite-invalid-revoked = 🗑️ Инвайт-код был отозван.
invite-created =
    🎟️ <b>Инвайт создан</b>

    Код: <code>{ $code }</code>
    Использований: <b>{ $uses }</b>
    Истекает: <b>{ $expires }</b>

    { $link }
invite-created-toast = 🎟️ Инвайт создан
invite-draft =
    🎟️ Настройки инвайта

    Использований: { $uses }
    Истекает: { $expires }

    Настройте кнопками и создайте инвайт.
invite-btn-uses = 🔢 Использований { $uses }
invite-btn-exp-7d = 📅 7 дней
invite-btn-exp-30d = 📅 30 дней
invite-btn-exp-never = ♾️ Без срока
invite-btn-create = ✅ Создать инвайт
invite-btn-open = 🔗 Открыть инвайт
invite-btn-revoke = 🗑️ Отозвать { $code }
invite-exp-never = ♾️ никогда
invite-status-active = ✅ активен
invite-status-expired = ⏳ истек
invite-status-revoked = 🗑️ отозван
invite-revoked-toast = 🗑️ Инвайт отозван
invite-revoked = 🗑️ Инвайт отозван.
invites-empty = 📭 Инвайтов пока нет.
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
image-generated-done = Готово — изображение готово.
image-generated-ready = Готово — изображение готово.
thinking-summary-running = 🧠 Думаю уже { $time }
thinking-summary-generating-image = 🖼️ Генерирую изображение уже { $time }
thinking-summary-final = 🧠 Думал { $time }
thinking-final-tool-calls = Вызовы инструментов: { $count }
thinking-final-reasoning = Блоков рассуждений: { $count }
thinking-final-tools = Инструменты:
thinking-final-files = Отправлено файлов: { $count }
thinking-final-files-capped = Отправлено файлов: { $sent } из { $requested } (лимит { $limit })
show-more = 📖 Показать еще
ctx-limit = 🧠 Чат близок к лимиту контекста модели. Сожмите память или начните новую тему Telegram для чистого треда.
btn-compact = 🗜 Сжать
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
file-processing-embedding = 🧠 Создаю векторный индекс для <code>{ $name }</code>...
    { $percent }%
file-processing-stopping = 🛑 Останавливаю обработку файла...
file-processing-cancelled = 🛑 Обработка файла отменена.
file-stop-none = ℹ️ В этом треде нет активной обработки файла.
file-processed = ✅ Файл <code>{ $name }</code> обработан.
file-reused = ♻️ Использую сохраненный файл <code>{ $name }</code>.
docling-down = ⚠️ Docling недоступен. Запустите: docker compose up -d docling.
fork-created = 🌱 Форк создан. Контекст перенесен в новую тему.
fork-need-topics = 🧵 Темы не включены для этого бота. Сначала включите Topics в BotFather.
help = 🧭 Команды: /lang, /timezone, /stream, /stop, /fork, /compact, /help. Для чистого треда начните новую тему Telegram; /fork переносит контекст в новую тему. /stop отменяет активную обработку файла в этом треде.
private-only = 🔒 Я работаю только в личных чатах.
unknown-command = ❓ Неизвестная команда. Попробуйте /help.
