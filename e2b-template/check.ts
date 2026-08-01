import "dotenv/config";
import { E2B_TOOLBOX_PRODUCTION_REF } from "./template.js";
import { requireE2BApiKey, validateE2BToolboxTemplate } from "./validate.js";

const result = await validateE2BToolboxTemplate(E2B_TOOLBOX_PRODUCTION_REF, requireE2BApiKey());
process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
