import type { ChatSettings, ChatSettingsPatch } from "../../chat-types.js";

type Patch = ChatSettingsPatch;

/**
 * Saves run one at a time, so every response is the server's state after all earlier saves.
 * Unsaved patches stay visible on top of that state; a failed save drops only its own patch.
 */
export class SettingsSync {
  private confirmed: ChatSettings | null = null;
  private pending: { id: number; patch: Patch }[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 0;
  /** Changes whenever a save starts or ends, so reads that overlapped one are discarded. */
  private generation = 0;
  private closed = false;

  constructor(private readonly options: {
    save: (patch: Patch) => Promise<ChatSettings>;
    /** The settings to show: the last confirmed state plus unsaved changes. */
    changed: (settings: ChatSettings) => void;
    /** A state the server confirmed. */
    confirmed?: (settings: ChatSettings) => void;
  }) {}

  get settings(): ChatSettings | null {
    return this.confirmed && this.pending.reduce<ChatSettings>((settings, item) => ({ ...settings, ...item.patch }), this.confirmed);
  }

  /** Call before a background read and pass the token to `received`. */
  beginRead(): number { return this.generation; }

  /** Applies a background read unless a save overlapped it. */
  received(value: ChatSettings, token: number): boolean {
    if (this.closed || token !== this.generation || this.pending.length) return false;
    this.confirm(value);
    this.publish();
    return true;
  }

  /** Resolves once this change is saved; rejects with the save error after rolling it back. */
  update(patch: Patch): Promise<void> {
    if (this.closed || !this.confirmed) return Promise.resolve();
    const id = ++this.nextId;
    this.pending.push({ id, patch });
    this.generation++;
    this.publish();
    const run = this.queue.then(async () => {
      try {
        // A signed-out workspace must not send changes that were still waiting.
        if (this.closed) throw new Error("Settings are closed.");
        this.confirm(await this.options.save(patch));
      } finally {
        this.pending = this.pending.filter(item => item.id !== id);
        this.generation++;
        this.publish();
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  close() { this.closed = true; }

  private confirm(value: ChatSettings) {
    if (this.closed) return;
    this.confirmed = value;
    this.options.confirmed?.(value);
  }

  private publish() {
    const settings = this.settings;
    if (!this.closed && settings) this.options.changed(settings);
  }
}
