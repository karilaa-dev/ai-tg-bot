import "dotenv/config";
import { Template, defaultBuildLogger } from "e2b";
import {
  E2B_TOOLBOX_CPU_COUNT,
  E2B_TOOLBOX_MEMORY_MB,
  E2B_TOOLBOX_PRODUCTION_TAG,
  E2B_TOOLBOX_TEMPLATE_NAME,
  e2bToolboxBuildRef,
  e2bToolboxTemplate,
} from "./template.js";
import { requireE2BApiKey, validateE2BToolboxTemplate } from "./validate.js";

const apiKey = requireE2BApiKey();
const buildTag = buildTimestampTag(new Date());
const buildInfo = await Template.build(e2bToolboxTemplate, E2B_TOOLBOX_TEMPLATE_NAME, {
  apiKey,
  tags: [buildTag],
  cpuCount: E2B_TOOLBOX_CPU_COUNT,
  memoryMB: E2B_TOOLBOX_MEMORY_MB,
  onBuildLogs: defaultBuildLogger(),
});

const exactRef = e2bToolboxBuildRef(buildTag);
await validateE2BToolboxTemplate(exactRef, apiKey);
await Template.assignTags(
  exactRef,
  E2B_TOOLBOX_PRODUCTION_TAG,
  { apiKey },
);

process.stdout.write(`${JSON.stringify({
  ok: true,
  template: E2B_TOOLBOX_TEMPLATE_NAME,
  versionTag: buildTag,
  productionRef: `${E2B_TOOLBOX_TEMPLATE_NAME}:${E2B_TOOLBOX_PRODUCTION_TAG}`,
  templateId: buildInfo.templateId,
  buildId: buildInfo.buildId,
  cpuCount: E2B_TOOLBOX_CPU_COUNT,
  memoryMB: E2B_TOOLBOX_MEMORY_MB,
}, null, 2)}\n`);

function buildTimestampTag(date: Date): string {
  return `build-${date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
}
