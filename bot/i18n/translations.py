"""Translations and i18n support."""

from enum import Enum


class Language(str, Enum):
    """Supported languages."""

    EN = "en"
    RU = "ru"
    UK = "uk"


TRANSLATIONS: dict[str, dict[Language, str]] = {
    # Command descriptions (for Telegram menu)
    "cmd_start_desc": {
        Language.EN: "Start the bot",
        Language.RU: "Запустить бота",
        Language.UK: "Запустити бота",
    },
    "cmd_help_desc": {
        Language.EN: "Show help",
        Language.RU: "Показать справку",
        Language.UK: "Показати довідку",
    },
    "cmd_thinking_desc": {
        Language.EN: "Toggle AI thinking",
        Language.RU: "Показ размышлений ИИ",
        Language.UK: "Показ роздумів ШІ",
    },
    "cmd_redo_desc": {
        Language.EN: "Regenerate response",
        Language.RU: "Сгенерировать заново",
        Language.UK: "Згенерувати заново",
    },
    "cmd_edit_desc": {
        Language.EN: "Edit last message",
        Language.RU: "Изменить сообщение",
        Language.UK: "Змінити повідомлення",
    },
    "cmd_lang_desc": {
        Language.EN: "Change language",
        Language.RU: "Сменить язык",
        Language.UK: "Змінити мову",
    },
    "cmd_invite_desc": {
        Language.EN: "Create invite code (admin)",
        Language.RU: "Создать приглашение (админ)",
        Language.UK: "Створити запрошення (адмін)",
    },
    "cmd_invites_desc": {
        Language.EN: "List invite codes (admin)",
        Language.RU: "Список приглашений (админ)",
        Language.UK: "Список запрошень (адмін)",
    },
    "cmd_deleteinvite_desc": {
        Language.EN: "Delete invite code (admin)",
        Language.RU: "Удалить приглашение (админ)",
        Language.UK: "Видалити запрошення (адмін)",
    },
    "cmd_approve_desc": {
        Language.EN: "Approve user by ID (admin)",
        Language.RU: "Одобрить пользователя (админ)",
        Language.UK: "Схвалити користувача (адмін)",
    },
    "cmd_code_desc": {
        Language.EN: "Enter invite code",
        Language.RU: "Ввести код приглашения",
        Language.UK: "Ввести код запрошення",
    },
    "cmd_timezone_desc": {
        Language.EN: "Set your timezone",
        Language.RU: "Установить часовой пояс",
        Language.UK: "Встановити часовий пояс",
    },
    # Welcome and help messages
    "start_welcome": {
        Language.EN: (
            "Hello\\! I'm an AI assistant\\.\n\n"
            "Send me a message, image, PDF, or text file and I'll respond\\.\n\n"
            "*Commands:*\n"
            "/help \\- Show help\n"
            "/thinking \\- Toggle AI thinking traces\n"
            "/redo \\- Regenerate last response\n"
            "/edit \\<text\\> \\- Edit and regenerate\n"
            "/lang \\- Change language\n"
            "/timezone \\- Set your timezone"
        ),
        Language.RU: (
            "Привет\\! Я ИИ\\-ассистент\\.\n\n"
            "Отправь мне сообщение, изображение, PDF или текстовый файл, и я отвечу\\.\n\n"
            "*Команды:*\n"
            "/help \\- Показать справку\n"
            "/thinking \\- Показ размышлений ИИ\n"
            "/redo \\- Сгенерировать заново\n"
            "/edit \\<текст\\> \\- Изменить и сгенерировать\n"
            "/lang \\- Сменить язык\n"
            "/timezone \\- Установить часовой пояс"
        ),
        Language.UK: (
            "Привіт\\! Я ШІ\\-асистент\\.\n\n"
            "Надішли мені повідомлення, зображення, PDF або текстовий файл, і я відповім\\.\n\n"
            "*Команди:*\n"
            "/help \\- Показати довідку\n"
            "/thinking \\- Показ роздумів ШІ\n"
            "/redo \\- Згенерувати заново\n"
            "/edit \\<текст\\> \\- Змінити та згенерувати\n"
            "/lang \\- Змінити мову\n"
            "/timezone \\- Встановити часовий пояс"
        ),
    },
    "help_text": {
        Language.EN: (
            "*AI Assistant Help*\n\n"
            "I can understand text, images, PDF files, and .txt/.md documents\\. "
            "I can also search the web and read webpages\\.\n\n"
            "*Commands:*\n"
            "/start \\- Start the bot\n"
            "/help \\- Show this help\n"
            "/thinking \\- Toggle AI thinking traces\n"
            "/redo \\- Regenerate the last response\n"
            "/edit \\<text\\> \\- Edit last message and regenerate\n"
            "/lang \\- Change interface language\n"
            "/timezone \\- Set your timezone\n\n"
            "*Tips:*\n"
            "• Send images, PDFs, or text files with a caption for analysis\n"
            "• Ask me to search the web for current information\n"
            "• Enable thinking mode to see my reasoning process"
        ),
        Language.RU: (
            "*Справка по ИИ\\-ассистенту*\n\n"
            "Я понимаю текст, изображения, PDF\\-файлы и документы .txt/.md\\. "
            "Также я могу искать в интернете и читать веб\\-страницы\\.\n\n"
            "*Команды:*\n"
            "/start \\- Запустить бота\n"
            "/help \\- Показать эту справку\n"
            "/thinking \\- Показ размышлений ИИ\n"
            "/redo \\- Сгенерировать последний ответ заново\n"
            "/edit \\<текст\\> \\- Изменить сообщение и сгенерировать\n"
            "/lang \\- Сменить язык интерфейса\n"
            "/timezone \\- Установить часовой пояс\n\n"
            "*Советы:*\n"
            "• Отправляй изображения, PDF или текстовые файлы с подписью для анализа\n"
            "• Попроси меня поискать актуальную информацию в интернете\n"
            "• Включи режим размышлений, чтобы видеть ход моих мыслей"
        ),
        Language.UK: (
            "*Довідка по ШІ\\-асистенту*\n\n"
            "Я розумію текст, зображення, PDF\\-файли та документи .txt/.md\\. "
            "Також я можу шукати в інтернеті та читати веб\\-сторінки\\.\n\n"
            "*Команди:*\n"
            "/start \\- Запустити бота\n"
            "/help \\- Показати цю довідку\n"
            "/thinking \\- Показ роздумів ШІ\n"
            "/redo \\- Згенерувати останню відповідь заново\n"
            "/edit \\<текст\\> \\- Змінити повідомлення та згенерувати\n"
            "/lang \\- Змінити мову інтерфейсу\n"
            "/timezone \\- Встановити часовий пояс\n\n"
            "*Поради:*\n"
            "• Надсилай зображення, PDF або текстові файли з підписом для аналізу\n"
            "• Попроси мене пошукати актуальну інформацію в інтернеті\n"
            "• Увімкни режим роздумів, щоб бачити хід моїх думок"
        ),
    },
    "text_file_too_large": {
        Language.EN: "That text file is too large\\. Please send a file under 1 MB\\.",
        Language.RU: "Этот текстовый файл слишком большой\\. Отправь файл меньше 1 МБ\\.",
        Language.UK: "Цей текстовий файл занадто великий\\. Надішли файл менше 1 МБ\\.",
    },
    "pdf_parse_failed": {
        Language.EN: "Couldn't parse that PDF\\. Please try again\\.",
        Language.RU: "Не удалось разобрать PDF\\. Попробуйте снова\\.",
        Language.UK: "Не вдалося розібрати PDF\\. Спробуйте ще раз\\.",
    },
    "pdf_too_large": {
        Language.EN: "That PDF is too large\\. Please send a smaller file\\.",
        Language.RU: "Этот PDF слишком большой\\. Отправь файл поменьше\\.",
        Language.UK: "Цей PDF занадто великий\\. Надішли менший файл\\.",
    },
    # Language selection
    "lang_select": {
        Language.EN: "Select your language:",
        Language.RU: "Выберите язык:",
        Language.UK: "Оберіть мову:",
    },
    "lang_changed": {
        Language.EN: "Language changed to English\\.",
        Language.RU: "Язык изменён на русский\\.",
        Language.UK: "Мову змінено на українську\\.",
    },
    # Thinking toggle
    "thinking_enabled": {
        Language.EN: "Thinking traces enabled\\.",
        Language.RU: "Показ размышлений включён\\.",
        Language.UK: "Показ роздумів увімкнено\\.",
    },
    "thinking_disabled": {
        Language.EN: "Thinking traces disabled\\.",
        Language.RU: "Показ размышлений выключен\\.",
        Language.UK: "Показ роздумів вимкнено\\.",
    },
    # Redo/edit messages
    "no_message_to_redo": {
        Language.EN: "No previous message to regenerate\\.",
        Language.RU: "Нет сообщения для повторной генерации\\.",
        Language.UK: "Немає повідомлення для повторної генерації\\.",
    },
    "edit_usage": {
        Language.EN: "Usage: /edit \\<new text\\>",
        Language.RU: "Использование: /edit \\<новый текст\\>",
        Language.UK: "Використання: /edit \\<новий текст\\>",
    },
    # Status messages (with emoji)
    "status_thinking": {
        Language.EN: "Thinking\\.\\.\\.",
        Language.RU: "Думаю\\.\\.\\.",
        Language.UK: "Думаю\\.\\.\\.",
    },
    "status_searching": {
        Language.EN: "Searching web\\.\\.\\.",
        Language.RU: "Ищу в интернете\\.\\.\\.",
        Language.UK: "Шукаю в інтернеті\\.\\.\\.",
    },
    "status_reading": {
        Language.EN: "Reading webpage\\.\\.\\.",
        Language.RU: "Читаю страницу\\.\\.\\.",
        Language.UK: "Читаю сторінку\\.\\.\\.",
    },
    # Invite system
    "invite_required": {
        Language.EN: (
            "This bot is invite\\-only\\.\n\n"
            "Please use a valid invite link to get access\\."
        ),
        Language.RU: (
            "Этот бот доступен только по приглашению\\.\n\n"
            "Пожалуйста, используйте действительную ссылку\\-приглашение\\."
        ),
        Language.UK: (
            "Цей бот доступний лише за запрошенням\\.\n\n"
            "Будь ласка, використайте дійсне посилання\\-запрошення\\."
        ),
    },
    "invite_success": {
        Language.EN: "Welcome\\! Your invite code has been accepted\\.",
        Language.RU: "Добро пожаловать\\! Ваш код приглашения принят\\.",
        Language.UK: "Ласкаво просимо\\! Ваш код запрошення прийнято\\.",
    },
    "invite_invalid": {
        Language.EN: "Invalid or expired invite code\\.",
        Language.RU: "Недействительный или истёкший код приглашения\\.",
        Language.UK: "Недійсний або прострочений код запрошення\\.",
    },
    "invite_exhausted": {
        Language.EN: "This invite code has reached its usage limit\\.",
        Language.RU: "Этот код приглашения исчерпал лимит использований\\.",
        Language.UK: "Цей код запрошення вичерпав ліміт використань\\.",
    },
    # Admin commands
    "admin_only": {
        Language.EN: "This command is for admins only\\.",
        Language.RU: "Эта команда только для администраторов\\.",
        Language.UK: "Ця команда лише для адміністраторів\\.",
    },
    "invite_created": {
        Language.EN: "Invite code created: `{code}`",
        Language.RU: "Код приглашения создан: `{code}`",
        Language.UK: "Код запрошення створено: `{code}`",
    },
    "invite_created_with_limit": {
        Language.EN: "Invite code created: `{code}` \\(max {max_uses} uses\\)",
        Language.RU: "Код приглашения создан: `{code}` \\(макс\\. {max_uses} использований\\)",
        Language.UK: "Код запрошення створено: `{code}` \\(макс\\. {max_uses} використань\\)",
    },
    "invite_code_exists": {
        Language.EN: "An invite code with this name already exists\\.",
        Language.RU: "Код приглашения с таким именем уже существует\\.",
        Language.UK: "Код запрошення з такою назвою вже існує\\.",
    },
    "invite_list_header": {
        Language.EN: "*Active invite codes:*",
        Language.RU: "*Активные коды приглашения:*",
        Language.UK: "*Активні коди запрошення:*",
    },
    "invite_list_empty": {
        Language.EN: "No active invite codes\\.",
        Language.RU: "Нет активных кодов приглашения\\.",
        Language.UK: "Немає активних кодів запрошення\\.",
    },
    "invite_list_item": {
        Language.EN: "• `{code}` \\- {uses} uses",
        Language.RU: "• `{code}` \\- {uses} использований",
        Language.UK: "• `{code}` \\- {uses} використань",
    },
    "invite_list_item_limited": {
        Language.EN: "• `{code}` \\- {current}/{max} uses",
        Language.RU: "• `{code}` \\- {current}/{max} использований",
        Language.UK: "• `{code}` \\- {current}/{max} використань",
    },
    "invite_deleted": {
        Language.EN: "Invite code `{code}` deleted\\.",
        Language.RU: "Код приглашения `{code}` удалён\\.",
        Language.UK: "Код запрошення `{code}` видалено\\.",
    },
    "invite_not_found": {
        Language.EN: "Invite code not found\\.",
        Language.RU: "Код приглашения не найден\\.",
        Language.UK: "Код запрошення не знайдено\\.",
    },
    "user_approved": {
        Language.EN: "User {user_id} has been approved\\.",
        Language.RU: "Пользователь {user_id} одобрен\\.",
        Language.UK: "Користувача {user_id} схвалено\\.",
    },
    "user_already_approved": {
        Language.EN: "User {user_id} is already approved\\.",
        Language.RU: "Пользователь {user_id} уже одобрен\\.",
        Language.UK: "Користувач {user_id} вже схвалений\\.",
    },
    "approve_usage": {
        Language.EN: "Usage: /approve \\<user\\_id\\>",
        Language.RU: "Использование: /approve \\<user\\_id\\>",
        Language.UK: "Використання: /approve \\<user\\_id\\>",
    },
    "deleteinvite_usage": {
        Language.EN: "Usage: /deleteinvite \\<code\\>",
        Language.RU: "Использование: /deleteinvite \\<код\\>",
        Language.UK: "Використання: /deleteinvite \\<код\\>",
    },
    # Inline mode and invite sharing
    "inline_new_invite_title": {
        Language.EN: "Send invite ({lang_name})",
        Language.RU: "Отправить приглашение ({lang_name})",
        Language.UK: "Надіслати запрошення ({lang_name})",
    },
    "inline_new_invite_desc": {
        Language.EN: "Creates a new one-time invite code",
        Language.RU: "Создаёт новый одноразовый код",
        Language.UK: "Створює новий одноразовий код",
    },
    "inline_custom_invite_desc": {
        Language.EN: "Code: {code}",
        Language.RU: "Код: {code}",
        Language.UK: "Код: {code}",
    },
    "inline_join_button": {
        Language.EN: "Start Bot",
        Language.RU: "Запустить бота",
        Language.UK: "Запустити бота",
    },
    "invite_share_message": {
        Language.EN: (
            "You've been invited to use *{bot_name}*\\.\n\n"
            "`/code {code}`\n\n"
            "_The button works on phone\\. On PC, send the command above to the bot\\._"
        ),
        Language.RU: (
            "Вас приглашают использовать *{bot_name}*\\.\n\n"
            "`/code {code}`\n\n"
            "_Кнопка работает на телефоне\\. На ПК отправьте команду выше боту\\._"
        ),
        Language.UK: (
            "Вас запрошують використовувати *{bot_name}*\\.\n\n"
            "`/code {code}`\n\n"
            "_Кнопка працює на телефоні\\. На ПК надішліть команду вище боту\\._"
        ),
    },
    # /code command
    "code_usage": {
        Language.EN: "Usage: /code \\<invite\\_code\\>",
        Language.RU: "Использование: /code \\<код\\_приглашения\\>",
        Language.UK: "Використання: /code \\<код\\_запрошення\\>",
    },
    "code_already_approved": {
        Language.EN: "You already have access to this bot\\!",
        Language.RU: "У вас уже есть доступ к этому боту\\!",
        Language.UK: "Ви вже маєте доступ до цього бота\\!",
    },
    # Timezone
    "timezone_usage": {
        Language.EN: "Usage: /timezone HH:MM \\- enter your current time \\(e\\.g\\., /timezone 15:30 or /timezone 3:30 PM\\)",
        Language.RU: "Использование: /timezone ЧЧ:ММ \\- введите ваше текущее время \\(напр\\., /timezone 15:30 или /timezone 3:30 PM\\)",
        Language.UK: "Використання: /timezone ГГ:ХХ \\- введіть ваш поточний час \\(напр\\., /timezone 15:30 або /timezone 3:30 PM\\)",
    },
    "timezone_current": {
        Language.EN: "Your timezone: {timezone}",
        Language.RU: "Ваш часовой пояс: {timezone}",
        Language.UK: "Ваш часовий пояс: {timezone}",
    },
    "timezone_set": {
        Language.EN: "Timezone set to {timezone}",
        Language.RU: "Часовой пояс установлен: {timezone}",
        Language.UK: "Часовий пояс встановлено: {timezone}",
    },
    "timezone_invalid": {
        Language.EN: "Invalid format\\. Use: /timezone HH:MM \\(e\\.g\\., /timezone 15:30 or /timezone 3:30 PM\\)",
        Language.RU: "Неверный формат\\. Используйте: /timezone ЧЧ:ММ \\(напр\\., /timezone 15:30 или /timezone 3:30 PM\\)",
        Language.UK: "Невірний формат\\. Використовуйте: /timezone ГГ:ХХ \\(напр\\., /timezone 15:30 або /timezone 3:30 PM\\)",
    },
}


# Telegram language code to supported language mapping
_LANG_CODE_MAP: dict[str, Language] = {
    "en": Language.EN,
    "ru": Language.RU,
    "uk": Language.UK,
    "ua": Language.UK,  # Alternative code
    "be": Language.RU,  # Belarusian -> Russian
    "kk": Language.RU,  # Kazakh -> Russian
}


def detect_language(telegram_lang_code: str | None) -> Language:
    """Map Telegram language code to supported language.

    Falls back to English if language is not supported.
    """
    if not telegram_lang_code:
        return Language.EN

    # Try exact match first
    code = telegram_lang_code.lower()
    if code in _LANG_CODE_MAP:
        return _LANG_CODE_MAP[code]

    # Try base language (e.g., "en-US" -> "en")
    base_code = code.split("-")[0]
    return _LANG_CODE_MAP.get(base_code, Language.EN)


def get_text(key: str, lang: Language | str, **kwargs: str) -> str:
    """Get translated text for a key.

    Args:
        key: Translation key
        lang: Language enum or string code
        **kwargs: Format arguments for the text

    Returns:
        Translated text, or the key if not found
    """
    if isinstance(lang, str):
        try:
            lang = Language(lang)
        except ValueError:
            lang = Language.EN

    translations = TRANSLATIONS.get(key)
    if not translations:
        return key

    text = translations.get(lang, translations.get(Language.EN, key))

    if kwargs:
        text = text.format(**kwargs)

    return text


async def get_user_language(telegram_id: int) -> Language:
    """Get user's language preference from database.

    Args:
        telegram_id: Telegram user ID

    Returns:
        User's preferred Language, defaults to EN if not set or invalid
    """
    from bot.database.repository import repository

    async with repository.session_factory() as session:
        lang_code = await repository.get_user_language(session, telegram_id)

    if lang_code:
        try:
            return Language(lang_code)
        except ValueError:
            pass
    return Language.EN
