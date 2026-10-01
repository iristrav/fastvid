import { APP_ERROR, type AppErrorCode, appErrorMessage } from "../appErrors";

/**
 * Base HTTP error class with status code.
 * Throw this from route handlers to send specific HTTP errors.
 */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const ForbiddenError = (msg: string, code: AppErrorCode = APP_ERROR.FORBIDDEN_RESOURCE) =>
  new HttpError(403, appErrorMessage(code, msg));
