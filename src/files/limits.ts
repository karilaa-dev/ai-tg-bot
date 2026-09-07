export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_CREATED_FILES_PER_ANSWER = 25;
export const TG_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

export class FileTooLargeError extends Error {
  constructor(message = "File exceeds the configured size limit.") {
    super(message);
    this.name = "FileTooLargeError";
  }
}
