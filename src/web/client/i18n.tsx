import { createContext, useContext } from "react";
import { MAX_FILE_BYTES } from "../../files/limits.js";

const fileLimitMiB = MAX_FILE_BYTES / (1024 * 1024);

/** Interface languages; the chat follows the bot's persisted ChatSettings.language. */
export type UiLanguage = "en" | "ru";

export const isUiLanguage = (value: unknown): value is UiLanguage => value === "en" || value === "ru";

/** Admin pages never provide a language, so shared components stay English there. */
export const UiLanguageContext = createContext<UiLanguage>("en");
export const useUiLanguage = () => useContext(UiLanguageContext);

/** The visitor's regional variant of the interface language (en-GB, ru-RU…) for dates and numbers. */
export function localeFor(language: UiLanguage): string {
  const preferred = typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  return preferred.find(tag => tag?.toLowerCase().split("-")[0] === language) ?? language;
}

/** Best guess before any account preference is known. */
export function browserLanguage(): UiLanguage {
  if (typeof navigator === "undefined") return "en";
  const preferred = navigator.languages?.length ? navigator.languages : [navigator.language];
  return preferred[0]?.toLowerCase().startsWith("ru") ? "ru" : "en";
}

/** Russian chooses between one, few, and many; English between one and other. */
export function plural(language: UiLanguage, count: number, forms: { one: string; few: string; many: string }): string {
  const category = new Intl.PluralRules(language).select(count);
  return category === "one" ? forms.one : category === "few" ? forms.few : forms.many;
}

export function fileSize(language: UiLanguage, size: number, digits = 1): string {
  const units = language === "ru" ? ["Б", "КБ", "МБ"] : ["B", "KiB", "MiB"];
  const format = (value: number, fraction: number) => new Intl.NumberFormat(localeFor(language), { maximumFractionDigits: fraction }).format(value);
  if (size < 1024) return `${format(size, 0)} ${units[0]}`;
  if (size < 1024 * 1024) return `${format(size / 1024, digits)} ${units[1]}`;
  return `${format(size / 1024 / 1024, 1)} ${units[2]}`;
}

const toolCalls = (language: UiLanguage, count: number) => language === "ru"
  ? `${count} ${plural("ru", count, { one: "вызов инструмента", few: "вызова инструментов", many: "вызовов инструментов" })}`
  : `${count} tool ${count === 1 ? "call" : "calls"}`;

const en = {
  copyCode: "Copy code",
  copied: "Copied",
  codeRegion: (language: string) => `${language} code`,
  externalImage: (alt: string) => alt ? `[External image: ${alt}]` : "[External image]",
  thinking: "Thinking",
  thinkingRegion: "Thinking and tool details",
  toolCalls: (count: number) => toolCalls("en", count),
  activity: { queued: "Waiting to start", generating: "Generating response…", delivering: "Sending response…", stopping: "Stopping response…", interrupted: "Response interrupted" },
  queuedTurns: (count: number) => `${count} queued`,
  statusUnavailable: "Status unavailable · Reconnecting…",
  unknownSize: "Unknown size",
  saveImage: "Save image",
  saveFile: (name: string) => `Save ${name}`,
  save: "Save",
  loading: "Loading…",
  retry: "Retry",
  loadImage: "Load image",
  loadAudio: "Load audio",
  loadFile: "Load file",
  exceedsLimit: `Exceeds the ${fileLimitMiB} MiB limit`,
  exceedsLimitShort: ` · Exceeds ${fileLimitMiB} MiB limit`,
  loadingSuffix: " · Loading",
  waitingSandbox: "Waiting for sandbox approval",
  previewUnavailable: "Preview unavailable",
  loadingKind: (kind: "image" | "audio" | "file") => `Loading ${kind}…`,
  loadingImage: "Loading image…",
  mediaPreview: (kind: "image" | "audio"): string => kind === "image" ? "Image preview" : "Audio preview",
  imageLabel: (caption: string) => `Image: ${caption}`,
  attachedPhoto: "Attached photo",
  attachedImage: "Attached image",
  imageDetails: "Image details",
  detailFile: "File",
  detailSize: "Size",
  detailFormat: "Format",
  detailDimensions: "Dimensions",
  audioMessage: "Audio message",
  audioUnsupported: "Your browser cannot play this audio. Use Save to download it.",
  transcription: "Transcription",
  savedPreview: " · Saved preview",
  sandboxPrompt: "Retrieve this file using its sandbox? If paused, it will start temporarily and pause again as soon as the file is loaded.",
  sandboxLoad: "Start sandbox and load",
  mediaErrorBefore: "This preview could not be opened. You can save the file or ",
  mediaErrorRetry: "retry",
  mediaErrorAfter: ".",
  textPreview: "Text preview",
  firstKilobytes: " · First 64 KiB",
  fileLoadFailed: "Could not load this file.",
  memories: "Memories",
  backToConversations: "Back to conversations",
  refresh: "Refresh",
  loadingMemories: "Loading memories…",
  memoriesFailed: "Could not load memories.",
  savedNotes: (count: number) => `${count} saved ${count === 1 ? "note" : "notes"}`,
  memoryOn: "Memory on",
  memoryOff: "Memory off",
  oldestFirst: "Oldest first",
  memoryDisabled: "Memory is off. Previously saved notes are kept.",
  note: (id: number) => `Note #${id}`,
  savedMemories: "Saved memories",
  noNotesOnPage: "No notes on this page",
  earlierPage: "Go back to an earlier page.",
  noMemories: "No saved memories yet",
  noMemoriesHint: "Notes will appear here when the assistant saves something to remember.",
  memoryPages: "Memory pages",
  previous: "Previous",
  next: "Next",
  page: (page: number, pages: number) => `Page ${page} of ${pages}`,
  deleteNote: (id: number) => `Delete note #${id}`,
  deleteMemoryTitle: "Delete this memory?",
  deleteMemoryDescription: "This saved note will be permanently deleted. This can’t be undone.",
  delete: "Delete",
  cancel: "Cancel",
  memoryDeleted: "Memory deleted.",
  memoryDeleteFailed: "Could not delete this memory.",
  memoryAlreadyDeleted: "This memory was already deleted.",
};

export type SharedStrings = typeof en;

const ru: SharedStrings = {
  copyCode: "Копировать код",
  copied: "Скопировано",
  codeRegion: language => `Код: ${language}`,
  externalImage: alt => alt ? `[Внешнее изображение: ${alt}]` : "[Внешнее изображение]",
  thinking: "Рассуждения",
  thinkingRegion: "Рассуждения и вызовы инструментов",
  toolCalls: count => toolCalls("ru", count),
  activity: { queued: "Ожидает запуска", generating: "Пишет ответ…", delivering: "Отправляет ответ…", stopping: "Останавливает ответ…", interrupted: "Ответ прерван" },
  queuedTurns: count => `в очереди: ${count}`,
  statusUnavailable: "Статус недоступен · Переподключение…",
  unknownSize: "Размер неизвестен",
  saveImage: "Сохранить изображение",
  saveFile: name => `Сохранить ${name}`,
  save: "Сохранить",
  loading: "Загрузка…",
  retry: "Повторить",
  loadImage: "Загрузить изображение",
  loadAudio: "Загрузить аудио",
  loadFile: "Загрузить файл",
  exceedsLimit: `Превышает лимит ${fileLimitMiB} МиБ`,
  exceedsLimitShort: ` · Превышает лимит ${fileLimitMiB} МиБ`,
  loadingSuffix: " · Загрузка",
  waitingSandbox: "Ожидает подтверждения песочницы",
  previewUnavailable: "Предпросмотр недоступен",
  loadingKind: kind => kind === "image" ? "Загрузка изображения…" : kind === "audio" ? "Загрузка аудио…" : "Загрузка файла…",
  loadingImage: "Загрузка изображения…",
  mediaPreview: kind => kind === "image" ? "Предпросмотр изображения" : "Предпросмотр аудио",
  imageLabel: caption => `Изображение: ${caption}`,
  attachedPhoto: "Прикреплённое фото",
  attachedImage: "Прикреплённое изображение",
  imageDetails: "Сведения об изображении",
  detailFile: "Файл",
  detailSize: "Размер",
  detailFormat: "Формат",
  detailDimensions: "Размеры",
  audioMessage: "Аудиосообщение",
  audioUnsupported: "Браузер не может воспроизвести это аудио. Нажмите «Сохранить», чтобы скачать его.",
  transcription: "Расшифровка",
  savedPreview: " · Сохранённый фрагмент",
  sandboxPrompt: "Получить файл из его песочницы? Если она приостановлена, то временно запустится и снова приостановится сразу после загрузки файла.",
  sandboxLoad: "Запустить песочницу и загрузить",
  mediaErrorBefore: "Не удалось открыть предпросмотр. Сохраните файл или ",
  mediaErrorRetry: "повторите попытку",
  mediaErrorAfter: ".",
  textPreview: "Предпросмотр текста",
  firstKilobytes: " · Первые 64 КБ",
  fileLoadFailed: "Не удалось загрузить файл.",
  memories: "Воспоминания",
  backToConversations: "Назад к разговорам",
  refresh: "Обновить",
  loadingMemories: "Загрузка воспоминаний…",
  memoriesFailed: "Не удалось загрузить воспоминания.",
  savedNotes: count => `${count} ${plural("ru", count, { one: "сохранённая запись", few: "сохранённые записи", many: "сохранённых записей" })}`,
  memoryOn: "Память включена",
  memoryOff: "Память выключена",
  oldestFirst: "Сначала старые",
  memoryDisabled: "Память выключена. Сохранённые записи остаются.",
  note: id => `Запись №${id}`,
  savedMemories: "Сохранённые воспоминания",
  noNotesOnPage: "На этой странице нет записей",
  earlierPage: "Вернитесь на предыдущую страницу.",
  noMemories: "Сохранённых воспоминаний пока нет",
  noMemoriesHint: "Записи появятся здесь, когда ассистент что-нибудь запомнит.",
  memoryPages: "Страницы воспоминаний",
  previous: "Назад",
  next: "Далее",
  page: (page, pages) => `Страница ${page} из ${pages}`,
  deleteNote: id => `Удалить запись №${id}`,
  deleteMemoryTitle: "Удалить это воспоминание?",
  deleteMemoryDescription: "Эта сохранённая запись будет удалена навсегда. Это действие нельзя отменить.",
  delete: "Удалить",
  cancel: "Отмена",
  memoryDeleted: "Воспоминание удалено.",
  memoryDeleteFailed: "Не удалось удалить воспоминание.",
  memoryAlreadyDeleted: "Это воспоминание уже удалено.",
};

const shared: Record<UiLanguage, SharedStrings> = { en, ru };

/** Strings for components that both the chat and the English-only admin render. */
export function sharedStrings(language: UiLanguage): SharedStrings { return shared[language]; }
export function useSharedStrings(): SharedStrings { return shared[useUiLanguage()]; }

/** Server messages are English; the Russian interface translates the ones a person can act on. */
const russianErrors = new Map<string, string>([
  ["Your session ended. Sign in again to continue.", "Сеанс завершён. Войдите снова, чтобы продолжить."],
  ["Sign in with Telegram to continue.", "Войдите через Telegram, чтобы продолжить."],
  ["Your account changed. Reload the page to continue.", "Аккаунт изменился. Обновите страницу, чтобы продолжить."],
  ["Too many requests. Try again shortly.", "Слишком много запросов. Попробуйте чуть позже."],
  ["Too many requests. Wait a moment and try again.", "Слишком много запросов. Подождите немного и попробуйте снова."],
  ["Your previous message is still being accepted. Try again shortly.", "Предыдущее сообщение ещё принимается. Попробуйте чуть позже."],
  ["Other uploads are processing. Try again shortly.", "Сейчас обрабатываются другие загрузки. Попробуйте чуть позже."],
  ["Other files are loading. Try again shortly.", "Сейчас загружаются другие файлы. Попробуйте чуть позже."],
  ["Fork this archived conversation to continue it.", "Этот разговор в архиве. Создайте форк, чтобы продолжить его."],
  ["This message has no saved model checkpoint. Fork the whole chat or choose an earlier completed reply.", "Для этого сообщения нет сохранённой точки модели. Создайте форк всего чата или выберите более ранний завершённый ответ."],
  ["Write a message or attach a file.", "Напишите сообщение или прикрепите файл."],
  ["Enter a message of at most 32,000 characters and a valid request ID.", "Сообщение должно быть не длиннее 32 000 символов."],
  ["Attach up to 10 files, each at most 50 MiB (500 MiB total).", "Прикрепите не больше 10 файлов размером до 50 МиБ каждый (до 500 МиБ всего)."],
  ["Upload up to 10 files, each at most 50 MiB (500 MiB total).", "Загрузите не больше 10 файлов размером до 50 МиБ каждый (до 500 МиБ всего)."],
  ["Upload up to 10 files.", "Можно загрузить не больше 10 файлов."],
  ["Upload exceeds the file size limit.", "Размер каждого файла не должен превышать 50 МиБ (до 500 МиБ всего)."],
  ["Upload timed out.", "Время загрузки истекло. Попробуйте снова."],
  ["Invalid file name or empty file.", "Недопустимое имя файла или пустой файл."],
  ["These files are too large to send.", "Файлы слишком большие для отправки."],
  ["Enable topics for this bot in BotFather before creating a conversation.", "Включите темы для этого бота в BotFather, чтобы создавать разговоры."],
  ["Could not create the Telegram topic. Open the bot in Telegram, press Start, and try again.", "Не удалось создать тему в Telegram. Откройте бота в Telegram, нажмите «Старт» и попробуйте снова."],
  ["Use a conversation title of at most 128 characters.", "Название разговора должно быть не длиннее 128 символов."],
  ["Web chat is unavailable.", "Веб-чат недоступен."],
  ["The website is stopping.", "Сайт перезапускается. Попробуйте чуть позже."],
  ["Request timed out.", "Время ожидания запроса истекло."],
  ["Request is too large.", "Запрос слишком большой."],
  ["This action must come from this website.", "Это действие можно выполнить только на этом сайте."],
  ["This Telegram account is not allowed to use this bot.", "Этому аккаунту Telegram нельзя пользоваться ботом."],
  ["Not found.", "Не найдено."],
  ["Invalid request.", "Некорректный запрос."],
  ["Could not complete the request. Try again.", "Не удалось выполнить запрос. Попробуйте ещё раз."],
  ["The bot could not complete this request. Try again.", "Бот не смог выполнить запрос. Попробуйте ещё раз."],
  ["The request could not be completed. Try again.", "Не удалось выполнить запрос. Попробуйте ещё раз."],
  ["Could not load this file.", "Не удалось загрузить файл."],
  ["This file exceeds the 50 MiB download limit.", "Файл превышает лимит загрузки 50 МиБ."],
  ["Load this attachment manually.", "Загрузите это вложение вручную."],
  ["Attachment exceeds the download limit.", "Вложение превышает лимит загрузки."],
  ["This attachment could not be retrieved. Try again later.", "Не удалось получить вложение. Попробуйте позже."],
]);

export function localizeServerError(message: string, language: UiLanguage, status?: number): string {
  if (language === "en") return message;
  const known = russianErrors.get(message);
  if (known) return known;
  // Unknown English text falls back to a generic Russian sentence for its status class.
  return status === 429 ? "Слишком много запросов. Подождите немного и попробуйте снова." : status === 413 ? "Файлы слишком большие для отправки." : status !== undefined && status >= 500 ? "Бот не смог выполнить запрос. Попробуйте ещё раз." : "Не удалось выполнить запрос. Попробуйте ещё раз.";
}
