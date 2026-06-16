import { loadConfig } from "../src/config.js";
import { streamCodexTurn } from "../src/ai/codexAppServer.js";

const config = loadConfig();
const result = streamCodexTurn({
  config,
  prompt: "Reply with exactly: ok",
});

for await (const part of result.fullStream) {
  console.log(JSON.stringify(part));
}
