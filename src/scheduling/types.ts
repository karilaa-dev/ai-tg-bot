import { z } from "zod";

export const MIN_SCHEDULE_INTERVAL_MS = 60 * 60_000;
const timestamp = z.number().int().positive().max(8_640_000_000_000_000);
export const ScheduleInputSchema = z.object({
  threadId: z.uuid(),
  title: z.string().trim().min(1).max(128),
  prompt: z.string().trim().min(1).max(32_000),
  intervalMinutes: z.number().int().min(60).max(525_600).nullable(),
  nextRunAt: timestamp,
}).strict();
export const SchedulePatchSchema = ScheduleInputSchema.omit({ threadId: true }).partial().extend({
  enabled: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0, "Choose a schedule setting to update.");

export type ChatScheduleInput = z.infer<typeof ScheduleInputSchema>;
export type ChatSchedulePatch = z.infer<typeof SchedulePatchSchema>;
export interface ChatSchedule extends ChatScheduleInput {
  id: string;
  enabled: boolean;
  lastRunAt: number | null;
  lastTurnId: number | null;
  createdAt: number;
  updatedAt: number;
}

export class ScheduleError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}
