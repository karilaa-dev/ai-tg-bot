import type { InviteRow } from "../db/types.js";

type Translate = (key: string, params?: Record<string, string | number>) => string;

export const inviteUseOptions = [1, 5, 10] as const;
export const inviteExpiryOptions = ["7d", "30d", "never"] as const;
export type InviteExpiry = typeof inviteExpiryOptions[number];

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


export function inviteDraftKeyboard(t: Translate, uses: number, expiry: InviteExpiry) {
  return {
    inline_keyboard: [
      inviteUseOptions.map((option) => ({
        text: `${option === uses ? "[x] " : ""}${t("invite-btn-uses", { uses: option })}`,
        callback_data: `inv:set:${option}:${expiry}`,
      })),
      inviteExpiryOptions.map((option) => ({
        text: `${option === expiry ? "[x] " : ""}${t(`invite-btn-exp-${option}`)}`,
        callback_data: `inv:set:${uses}:${option}`,
      })),
      [{ text: t("invite-btn-create"), callback_data: `inv:create:${uses}:${expiry}` }],
    ],
  };
}

export function invitesListKeyboard(t: Translate, invites: InviteRow[]) {
  return {
    inline_keyboard: invites
      .filter((invite) => !invite.revoked)
      .map((invite) => [{ text: t("invite-btn-revoke", { code: invite.code }), callback_data: `inv:revoke:${invite.code}` }]),
  };
}
