import { Template, type BuildInfo, type LogEntry } from "e2b";
import { parseManagedE2BTemplateRef } from "../src/e2b/templateIdentity.js";
import {
  E2B_TOOLBOX_CPU_COUNT,
  E2B_TOOLBOX_MEMORY_MB,
  E2B_TOOLBOX_TEMPLATE_NAME,
  e2bToolboxTemplate,
} from "./template.js";

export async function buildE2BToolboxTemplate(
  templateRef: string,
  apiKey: string,
  onBuildLogs?: (entry: LogEntry) => void,
): Promise<BuildInfo> {
  const managed = parseManagedE2BTemplateRef(templateRef);
  if (!managed) throw new Error(`Cannot build unmanaged E2B template reference: ${templateRef}`);

  return Template.build(e2bToolboxTemplate, E2B_TOOLBOX_TEMPLATE_NAME, {
    apiKey,
    tags: [managed.tag],
    cpuCount: E2B_TOOLBOX_CPU_COUNT,
    memoryMB: E2B_TOOLBOX_MEMORY_MB,
    onBuildLogs,
  });
}
