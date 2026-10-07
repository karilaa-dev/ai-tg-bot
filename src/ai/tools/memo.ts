import { z } from "zod";
import { runMemo } from "../../memory/optmem/index.js";
import { DatabaseMemoryStore } from "../../memory/optmem/databaseStore.js";
import { memorySizes } from "../../memory/optmem/settings.js";
import { recallInWorker } from "../../memory/optmem/recall.js";
import { defineBotTool, type ToolBuildInput } from "./types.js";

export function createMemoTool(input: ToolBuildInput) {
  return defineBotTool({
    description: "OptMem permanent memory for this user, shared across their threads. Call with args:[\"wake\"] first, then follow every printed command, using this tool rather than bash. Commands: wake [part [T]], note <one line>, nap [block summary], recall <regex>, zoom <block>, forget <block>, config (read-only global settings). Summaries are written by you when requested; forget only removes summaries. init/import are operator-only CLI commands.",
    inputSchema: z.object({ args: z.tuple([z.enum(["wake", "note", "nap", "recall", "zoom", "forget", "config"])]).rest(z.string()) }),
    execute: async ({ args }, signal) => {
      signal?.throwIfAborted();
      const memory = { store: new DatabaseMemoryStore(input.db.db, input.user.tg_id, signal), settings: memorySizes(input.config) };
      const result = args[0] === "recall" && args.length === 2
        ? await recallInWorker(memory, args[1], signal)
        : await runMemo({ ...memory, args });
      return { ...result, command: args[0] };
    },
    toModelOutput: ({ output }) => ({ type: output.exit_code ? "error-text" : "text", value: output.stdout + output.stderr }),
  });
}
