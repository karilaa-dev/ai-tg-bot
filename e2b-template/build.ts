import "dotenv/config";
import { defaultBuildLogger } from "e2b";
import {
  E2B_TOOLBOX_CPU_COUNT,
  E2B_TOOLBOX_MEMORY_MB,
  E2B_TOOLBOX_TEMPLATE_NAME,
  e2bToolboxBuildRef,
} from "./template.js";
import { buildE2BToolboxTemplate } from "./builder.js";
import { requireE2BApiKey, validateE2BToolboxTemplate } from "./validate.js";

const buildTag = process.env.E2B_BUILD_TAG?.trim() || buildTimestampTag(new Date());
const exactRef = e2bToolboxBuildRef(buildTag);
const apiKey = requireE2BApiKey();
const buildInfo = await buildE2BToolboxTemplate(exactRef, apiKey, defaultBuildLogger());

await validateE2BToolboxTemplate(exactRef, apiKey);

process.stdout.write(`${JSON.stringify({
  ok: true,
  template: E2B_TOOLBOX_TEMPLATE_NAME,
  versionTag: buildTag,
  immutableRef: exactRef,
  promoted: false,
  templateId: buildInfo.templateId,
  buildId: buildInfo.buildId,
  cpuCount: E2B_TOOLBOX_CPU_COUNT,
  memoryMB: E2B_TOOLBOX_MEMORY_MB,
}, null, 2)}\n`);

function buildTimestampTag(date: Date): string {
  return `build-${date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
}
