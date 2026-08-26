import "dotenv/config";
import { E2B_TOOLBOX_RELEASE_REF } from "../src/e2b/templateIdentity.js";
import { E2BTemplateReleaseManager } from "../src/e2b/templateRelease.js";
import { requireE2BApiKey } from "./validate.js";

const release = new E2BTemplateReleaseManager(requireE2BApiKey());
const result = await release.ensure(E2B_TOOLBOX_RELEASE_REF);

process.env.E2B_TEMPLATE = E2B_TOOLBOX_RELEASE_REF;
await import("../scripts/live-e2b-check.js");

process.stdout.write(`${JSON.stringify({
  ok: true,
  release: result,
  liveSmokePassed: true,
  deployment: { E2B_TEMPLATE: E2B_TOOLBOX_RELEASE_REF },
}, null, 2)}\n`);
