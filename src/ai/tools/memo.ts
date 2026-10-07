import { z } from "zod";
import { runMemo } from "../../memory/optmem/index.js";
import { userMemoryDirectory } from "../../memory/userMemory.js";
import { recallInWorker } from "../../memory/optmem/recall.js";
import { defineBotTool, type ToolBuildInput } from "./types.js";

export function createMemoTool(input: ToolBuildInput) {
  return defineBotTool({
    description: "OptMem permanent memory for this user, shared across their threads. Call with args:[\"wake\"] first, then follow every printed command, using this tool rather than bash. Commands: wake [part [T]], note <one line>, nap [block summary], recall <regex>, zoom <block>, forget <block>, config [NAME=VALUE]. Summaries are written by you when requested; forget only removes summaries. init/import are operator-only CLI commands.",
    inputSchema: z.object({ args: z.tuple([z.enum(["wake", "note", "nap", "recall", "zoom", "forget", "config"])]).rest(z.string()) }),
    execute: async ({ args }, signal) => {
      signal?.throwIfAborted();
      const directory = userMemoryDirectory(input.config, input.user.tg_id);
      const result = args[0] === "recall" && args.length === 2
        ? await recallInWorker(directory, args[1], signal)
        : await runMemo({ directory, args });
      return { ...result, command: args[0] };
    },
    toModelOutput: ({ output }) => ({ type: output.exit_code ? "error-text" : "text", value: output.stdout + output.stderr }),
  });
}
