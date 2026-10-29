export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const TG_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const MAX_CHAT_UPLOAD_FILES = 10;
export const MAX_CHAT_UPLOAD_BYTES = MAX_CHAT_UPLOAD_FILES * MAX_FILE_BYTES;
// Larger text files stay available as original sandbox sources, without host indexing.
export const MAX_INDEXED_TEXT_BYTES = 256 * 1024;
export const MAX_CREATED_FILES_PER_ANSWER = 25;
export const TG_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

export class FileTooLargeError extends Error {
  constructor(message = "File exceeds the configured size limit.") {
    super(message);
    this.name = "FileTooLargeError";
  }
}
