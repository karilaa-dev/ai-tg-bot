import type { AccessControl } from "../access/control.js";
import type { SchedulesRepo } from "../db/repos/schedules.js";
import type { Logger } from "../logger.js";

export class ChatScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  constructor(private readonly input: { schedules: SchedulesRepo; access: Pick<AccessControl, "isAllowed">;
    wake(threadId: string): void; logger: Logger }) {}

  start(): void {
    if (this.stopped || this.timer || this.running) return;
    this.running = this.tick().catch(error => this.input.logger.error("schedule scan failed", { error: String(error) }))
      .finally(() => {
        this.running = undefined;
        if (!this.stopped) {
          this.timer = setTimeout(() => { this.timer = undefined; this.start(); }, 30_000);
          this.timer.unref();
        }
      });
  }

  async tick(now = Date.now()): Promise<void> {
    for (const due of await this.input.schedules.due(now)) {
      if (this.stopped) return;
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

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
}
