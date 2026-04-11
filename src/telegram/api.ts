export interface TelegramCallOptions {
  chatId: number;
  messageThreadId?: number;
}

export interface TelegramMessageResult {
  message_id: number;
}

export type TelegramParseMode = 'MarkdownV2';

export interface TelegramFileResult {
  file_id: string;
  file_unique_id: string;
  file_path?: string;
  file_size?: number;
}

export class TelegramApiError extends Error {
  public constructor(
    message: string,
    public readonly errorCode: number,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

export class TelegramApiClient {
  private readonly baseUrl: string;
  private readonly fileBaseUrl: string;

  public constructor(private readonly token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.fileBaseUrl = `https://api.telegram.org/file/bot${token}`;
  }

  public async sendMessage(input: {
    chatId: number;
    messageThreadId?: number;
    text: string;
    parseMode?: TelegramParseMode;
  }): Promise<TelegramMessageResult> {
    return this.call<TelegramMessageResult>('sendMessage', {
      chat_id: input.chatId,
      message_thread_id: input.messageThreadId && input.messageThreadId > 0 ? input.messageThreadId : undefined,
      text: input.text,
      parse_mode: input.parseMode,
    });
  }

  public async sendMessageDraft(input: {
    chatId: number;
    messageThreadId?: number;
    draftId: number;
    text: string;
    parseMode?: TelegramParseMode;
  }): Promise<boolean> {
    return this.call<boolean>('sendMessageDraft', {
      chat_id: input.chatId,
      message_thread_id: input.messageThreadId && input.messageThreadId > 0 ? input.messageThreadId : undefined,
      draft_id: input.draftId,
      text: input.text,
      parse_mode: input.parseMode,
    });
  }

  public async sendChatAction(input: {
    chatId: number;
    messageThreadId?: number;
    action: string;
  }): Promise<boolean> {
    return this.call<boolean>('sendChatAction', {
      chat_id: input.chatId,
      message_thread_id: input.messageThreadId && input.messageThreadId > 0 ? input.messageThreadId : undefined,
      action: input.action,
    });
  }

  public async editMessageText(input: {
    chatId: number;
    messageId: number;
    text: string;
    parseMode?: TelegramParseMode;
  }): Promise<TelegramMessageResult> {
    return this.call<TelegramMessageResult>('editMessageText', {
      chat_id: input.chatId,
      message_id: input.messageId,
      text: input.text,
      parse_mode: input.parseMode,
    });
  }

  public async deleteMessage(input: {
    chatId: number;
    messageId: number;
  }): Promise<boolean> {
    return this.call<boolean>('deleteMessage', {
      chat_id: input.chatId,
      message_id: input.messageId,
    });
  }

  public async getFile(fileId: string): Promise<TelegramFileResult> {
    return this.call<TelegramFileResult>('getFile', {
      file_id: fileId,
    });
  }

  public async downloadFile(filePath: string): Promise<Uint8Array> {
    const response = await fetch(`${this.fileBaseUrl}/${filePath}`);

    if (!response.ok) {
      throw new Error(`Telegram file download failed with status ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }

  public async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const payload = (await response.json()) as {
      ok: boolean;
      result?: T;
      description?: string;
      error_code?: number;
      parameters?: {
        retry_after?: number;
      };
    };

    if (!response.ok || !payload.ok || payload.result === undefined) {
      throw new TelegramApiError(
        `Telegram API ${method} failed: ${payload.description ?? response.statusText} (${payload.error_code ?? response.status})`,
        payload.error_code ?? response.status,
        payload.parameters?.retry_after ?? null,
      );
    }

    return payload.result;
  }
}
