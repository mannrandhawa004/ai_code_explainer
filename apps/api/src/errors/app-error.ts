export class AppError extends Error {
  override readonly name = "AppError";

  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details: unknown | undefined = undefined,
  ) {
    super(message);
    Error.captureStackTrace(this, AppError);
  }
}
