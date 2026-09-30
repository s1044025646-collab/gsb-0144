export type ErrorCode =
  | 'VALIDATION'
  | 'UNSUPPORTED_ORBIT'
  | 'BELOW_SURFACE'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_RANGE'
  | 'PERSISTENCE'
  | 'BAD_REQUEST';

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly httpStatus: number;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
    this.httpStatus =
      code === 'NOT_FOUND'
        ? 404
        : code === 'CONFLICT'
          ? 409
          : code === 'VALIDATION' || code === 'BAD_REQUEST'
            ? 400
            : code === 'UNSUPPORTED_ORBIT' ||
                code === 'BELOW_SURFACE' ||
                code === 'INVALID_RANGE'
              ? 422
              : 500;
  }
}

export function fail(
  code: ErrorCode,
  message: string,
  details?: unknown,
): never {
  throw new DomainError(code, message, details);
}
