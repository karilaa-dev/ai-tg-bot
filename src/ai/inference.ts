import type { BuiltContext } from "../memory/contextBuilder.js";
import {
  createCodexConversationSummarizer,
  createCodexImageGenerator,
  createCodexImageCaptioner,
  streamCodexTurn,
} from "./codexAppServer.js";
import { buildToolRegistry, type ToolBuildInput } from "./tools/index.js";

export type InferenceInput = ToolBuildInput & {
  context: BuiltContext;
  abortSignal?: AbortSignal;
};

export function streamInference(input: InferenceInput): { fullStream: AsyncIterable<unknown> } {
  const imageGenerator = input.imageGenerator ?? createCodexImageGenerator(input.config, input.logger);
  return streamCodexTurn({
    config: input.config,
    system: input.context.system,
    messages: input.context.messages,
    tools: buildToolRegistry({ ...input, imageGenerator }),
    logger: input.logger,
    abortSignal: input.abortSignal,
  });
}

export function createImageCaptioner(config: InferenceInput["config"], logger?: InferenceInput["logger"]) {
  return createCodexImageCaptioner(config, logger);
}

export function createConversationSummarizer(config: InferenceInput["config"], logger?: InferenceInput["logger"]) {
  return createCodexConversationSummarizer(config, logger);
}
