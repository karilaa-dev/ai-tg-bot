import "dotenv/config";
import { E2B_TOOLBOX_RELEASE_REF } from "../src/e2b/templateIdentity.js";
import { requireE2BApiKey, validateE2BToolboxTemplate } from "./validate.js";

const templateRef = process.env.E2B_TEMPLATE?.trim() || E2B_TOOLBOX_RELEASE_REF;
const result = await validateE2BToolboxTemplate(templateRef, requireE2BApiKey());
process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
