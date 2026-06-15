import type { BotCommand } from "grammy/types";

const commands = [
  ["lang", { en: "🌐 Change language", ru: "🌐 Сменить язык" }],
  ["timezone", { en: "🕒 Set timezone", ru: "🕒 Установить часовой пояс" }],
  ["stream", { en: "🌊 Toggle streaming", ru: "🌊 Переключить стриминг" }],
  ["stop", { en: "🛑 Stop file processing", ru: "🛑 Остановить обработку файла" }],
  ["fork", { en: "🌱 Fork this topic", ru: "🌱 Создать форк темы" }],
  ["compact", { en: "🗜 Compact memory", ru: "🗜 Сжать память" }],
  ["help", { en: "🧭 Show help", ru: "🧭 Показать справку" }],
] as const;

export function localizedCommands(lang: "en" | "ru"): BotCommand[] {
  return commands.map(([command, description]) => ({ command, description: description[lang] }));
}
