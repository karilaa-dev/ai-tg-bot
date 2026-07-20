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

export function onboardingTimezoneKeyboard(t: (key: string) => string, includeMoscow: boolean) {
  const rows = [
    [
      { text: t("tz-onboarding-btn-set"), callback_data: "tz:onboarding:set" },
      { text: t("tz-onboarding-btn-later"), callback_data: "tz:onboarding:later" },
    ],
  ];
  if (includeMoscow) {
    rows.push([{ text: t("tz-onboarding-btn-moscow"), callback_data: "tz:onboarding:moscow" }]);
  }
  return { inline_keyboard: rows };
}
