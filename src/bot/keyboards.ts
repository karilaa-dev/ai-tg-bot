export function languageKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Русский", callback_data: "lang:ru" },
        { text: "English", callback_data: "lang:en" },
      ],
    ],
  };
}

export function contextLimitKeyboard(t: (key: string) => string) {
  return {
    inline_keyboard: [[{ text: t("btn-compact"), callback_data: "ctx:compact" }]],
  };
}
