import type { AccessControl } from "../access/control.js";
import type { SchedulesRepo } from "../db/repos/schedules.js";
import type { Logger } from "../logger.js";

type SchedulerState =
  | { phase: "idle" }
  | { phase: "scanning" | "stopping"; done: Promise<void> }
  | { phase: "waiting"; timer: ReturnType<typeof setTimeout> }
  | { phase: "stopped" };

export class ChatScheduler {
  private state: SchedulerState = { phase: "idle" };
  constructor(private readonly input: { schedules: SchedulesRepo; access: Pick<AccessControl, "isAllowed">;
    wake(threadId: string): void; logger: Logger }) {}

  start(): void {
    if (this.state.phase !== "idle") return;
    const done = Promise.resolve().then(() => this.tick())
      .catch(error => this.input.logger.error("schedule scan failed", { error: String(error) }))
      .finally(() => {
        if (this.state.phase === "stopping") {
          this.state = { phase: "stopped" };
          return;
        }
        const timer = setTimeout(() => {
          this.state = { phase: "idle" };
          this.start();
        }, 30_000);
        timer.unref();
        this.state = { phase: "waiting", timer };
      });
    this.state = { phase: "scanning", done };
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.isStopping()) return;
    for (const due of await this.input.schedules.due(now)) {
      if (this.isStopping()) return;
      try {
        if (!await this.input.access.isAllowed(due.user_id)) {
          await this.input.schedules.update(due.user_id, due.id, { enabled: false });
          continue;
        }
        const run = await this.input.schedules.enqueue(due.user_id, due.id, now);
        if (run) {
          this.input.wake(run.threadId);
          this.input.logger.info("scheduled chat queued", { scheduleId: due.id, ...run });
        }
      } catch (error) {
        this.input.logger.warn("scheduled chat could not be queued", { scheduleId: due.id, error: String(error) });
      }
    }
  }

  private isStopping(): boolean {
    return this.state.phase === "stopping" || this.state.phase === "stopped";
  }

  async stop(): Promise<void> {
    if (this.state.phase === "scanning" || this.state.phase === "stopping") {
      const { done } = this.state;
      this.state = { phase: "stopping", done };
      await done;
      return;
    }
    if (this.state.phase === "waiting") clearTimeout(this.state.timer);
    this.state = { phase: "stopped" };
  }
}
