/** Canonical application error codes shared by HTTP API and CLI. */
export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNSUPPORTED_ORBIT'
  | 'BAD_RANGE'
  | 'PERSISTENCE'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export function httpStatus(code: ErrorCode): number {
  switch (code) {
    case 'VALIDATION':
    case 'BAD_RANGE':
      return 400;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
      return 409;
    case 'UNSUPPORTED_ORBIT':
      return 422;
    case 'PERSISTENCE':
    case 'INTERNAL':
    default:
      return 500;
  }
}
