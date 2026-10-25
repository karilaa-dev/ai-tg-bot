import type { TurnInput } from "../ai/types.js";
import type { MessageRow, ThreadRow, TurnRunRow } from "../db/types.js";

export interface TurnFrontend {
  activity: {
    schedule(runId: number, threadId?: ThreadRow["id"]): void;
    recover(): Promise<void>;
    waitForIdle(threadId?: ThreadRow["id"]): Promise<void>;
    shutdown(): Promise<void>;
  };
  run(input: Omit<TurnInput, "api" | "chatId" | "messageThreadId">,
    context: { run: TurnRunRow; message: MessageRow }): Promise<void>;
}
