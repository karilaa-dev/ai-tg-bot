import "dotenv/config";
import { Template } from "e2b";
import {
  E2B_TOOLBOX_PRODUCTION_TAG,
  E2B_TOOLBOX_TEMPLATE_NAME,
  e2bToolboxBuildRef,
} from "./template.js";
import { requireE2BApiKey, validateE2BToolboxTemplate } from "./validate.js";

const buildTag = process.env.E2B_PROMOTE_TAG?.trim();
if (!buildTag) throw new Error("E2B_PROMOTE_TAG is required and must name a validated immutable build tag.");

const exactRef = e2bToolboxBuildRef(buildTag);
const apiKey = requireE2BApiKey();

// Revalidate the immutable build immediately before changing the production tag.
await validateE2BToolboxTemplate(exactRef, apiKey);
await Template.assignTags(exactRef, E2B_TOOLBOX_PRODUCTION_TAG, { apiKey });

process.stdout.write(`${JSON.stringify({
  ok: true,
  immutableRef: exactRef,
  productionRef: `${E2B_TOOLBOX_TEMPLATE_NAME}:${E2B_TOOLBOX_PRODUCTION_TAG}`,
  promoted: true,
}, null, 2)}\n`);
