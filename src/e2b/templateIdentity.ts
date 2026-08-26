import { APP_VERSION } from "../version.js";

export const E2B_TOOLBOX_TEMPLATE_NAME = "ai-tg-bot-tools";
export const E2B_TOOLBOX_PRODUCTION_TAG = "production";
export const E2B_TOOLBOX_PRODUCTION_REF = `${E2B_TOOLBOX_TEMPLATE_NAME}:${E2B_TOOLBOX_PRODUCTION_TAG}`;
export const E2B_TOOLBOX_RELEASE_TAG = `v${APP_VERSION}`;
export const E2B_TOOLBOX_RELEASE_REF = `${E2B_TOOLBOX_TEMPLATE_NAME}:${E2B_TOOLBOX_RELEASE_TAG}`;

const MANAGED_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export function parseManagedE2BTemplateRef(templateRef: string): { tag: string; templateRef: string } | undefined {
  const prefix = `${E2B_TOOLBOX_TEMPLATE_NAME}:`;
  if (!templateRef.startsWith(prefix)) return undefined;
  const tag = templateRef.slice(prefix.length);
  if (!MANAGED_TAG_PATTERN.test(tag)) return undefined;
  return { tag, templateRef: `${E2B_TOOLBOX_TEMPLATE_NAME}:${tag}` };
}
