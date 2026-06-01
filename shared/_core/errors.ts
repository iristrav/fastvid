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

export const BadRequestError = (msg: string, code: AppErrorCode = APP_ERROR.NOT_FOUND) =>
  new HttpError(400, appErrorMessage(code, msg));
export const UnauthorizedError = (msg: string, code: AppErrorCode = APP_ERROR.UNAUTHED) =>
  new HttpError(401, appErrorMessage(code, msg));
export const ForbiddenError = (msg: string, code: AppErrorCode = APP_ERROR.FORBIDDEN_RESOURCE) =>
  new HttpError(403, appErrorMessage(code, msg));
export const NotFoundError = (msg: string, code: AppErrorCode = APP_ERROR.NOT_FOUND) =>
  new HttpError(404, appErrorMessage(code, msg));
