import { streamText } from "ai";
import { loadConfig } from "../src/config.js";
import { chatModel, providerOptions } from "../src/ai/provider.js";

const config = loadConfig();
const result = streamText({
  model: chatModel(config),
  prompt: "Reply with exactly: ok",
  providerOptions: providerOptions(config),
});

for await (const part of result.fullStream) {
  console.log(JSON.stringify(part));
}
