import { z } from "zod";
import { AccessControl } from "../../access/control.js";
import { ScheduleInputSchema, SchedulePatchSchema, ScheduleError } from "../../scheduling/types.js";
import { defineBotTool, type ToolBuildInput } from "./types.js";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  ScheduleInputSchema.omit({ threadId: true }).extend({ action: z.literal("create") }).strict(),
  z.object({ action: z.literal("update"), id: z.uuid(), patch: SchedulePatchSchema }).strict(),
  z.object({ action: z.literal("delete"), id: z.uuid() }).strict(),
]);

export function createScheduleChatTool(input: ToolBuildInput) {
  return defineBotTool({
    description: "Create, list, edit, pause, resume or delete this user's scheduled chat checks. Create schedules in the current conversation (one per chat). Only schedule when the user asks. nextRunAt is a future Unix timestamp in milliseconds; intervalMinutes is null for once, otherwise 60–525600. Repeats use elapsed minutes, not local calendar/DST rules. Results are posted in the same chat even when the user is offline. List first to find an existing schedule before editing it. Pausing uses update patch enabled:false. Resuming an overdue schedule needs a future nextRunAt. Never promise a schedule before this tool succeeds.",
    inputSchema: z.object({ request: schema }).strict(),
    execute: async ({ request: args }, signal) => {
      signal?.throwIfAborted();
      const userId = input.user.tg_id;
      if (!await new AccessControl(input.db.db).isAllowed(userId)) return { error: "This account is not allowed to use the bot." };
      try {
        switch (args.action) {
          case "list": return { schedules: await input.repos.schedules.list(userId) };
          case "create": {
            const { action: _action, ...value } = args;
            return { schedule: await input.repos.schedules.create(userId, { ...value, threadId: input.thread.id }) };
          }
          case "update": return { schedule: await input.repos.schedules.update(userId, args.id, args.patch) };
          case "delete": await input.repos.schedules.delete(userId, args.id); return { deleted: true };
        }
      } catch (error) {
        if (error instanceof ScheduleError) return { error: error.message };
        throw error;
      }
    },
  });
}
