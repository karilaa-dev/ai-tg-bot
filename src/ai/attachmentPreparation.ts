import { OutgoingBuffers, OUTGOING_BUFFER_BYTES, prepareWithTwoWorkers } from "../files/outgoingBuffers.js";
import type { CreatedFileAttachment } from "../files/types.js";

/** Batches never cross a delivery-type boundary or reorder the attachment queue. */
function orderedAttachmentBatches(attachments: CreatedFileAttachment[]): CreatedFileAttachment[][] {
  const batches: CreatedFileAttachment[][] = [];
  for (const attachment of attachments) {
    const previous = batches.at(-1);
    if (previous && previous.length < 10
      && previous[0]!.delivery === attachment.delivery
      && previous.reduce((bytes, file) => bytes + file.size, 0) + attachment.size <= OUTGOING_BUFFER_BYTES) {
      previous.push(attachment);
    } else batches.push([attachment]);
  }
  return batches;
}

export class AttachmentPreparation {
  readonly batches: CreatedFileAttachment[][];
  private readonly pending = new Map<number, Promise<void>>();
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  readonly errors = new Map<CreatedFileAttachment, unknown>();

  constructor(private readonly input: {
    attachments: CreatedFileAttachment[];
    buffers: OutgoingBuffers;
    signal?: AbortSignal;
    load(file: CreatedFileAttachment, signal: AbortSignal): Promise<Buffer>;
    onPrepared?(file: CreatedFileAttachment, ms: number, error?: unknown): void;
  }) {
    this.batches = orderedAttachmentBatches(input.attachments);
    this.signal = input.signal ? AbortSignal.any([input.signal, this.controller.signal]) : this.controller.signal;
  }

  start(index = 0): void {
    if (this.pending.has(index) || !this.batches[index]) return;
    const batch = this.batches[index]!;
    this.pending.set(index, prepareWithTwoWorkers(batch, async (attachment) => {
      if (attachment.telegramDelivery || attachment.telegramDeliveryUnknown) return;
      const startedAt = Date.now();
      try {
        await this.input.buffers.load(attachment, () => this.input.load(attachment, this.signal), this.signal);
        this.input.onPrepared?.(attachment, Date.now() - startedAt);
      } catch (error) {
        this.errors.set(attachment, error);
        if (!this.signal.aborted) this.input.onPrepared?.(attachment, Date.now() - startedAt, error);
      }
    }).then(() => undefined));
  }

  async ready(index: number): Promise<CreatedFileAttachment[]> {
    this.start(index);
    await this.pending.get(index);
    this.signal.throwIfAborted();
    return this.batches[index]!.filter((file) => !this.errors.has(file));
  }

  async close(): Promise<void> {
    this.controller.abort();
    await Promise.allSettled(this.pending.values());
    for (const file of this.input.attachments) this.input.buffers.release(file);
  }
}
