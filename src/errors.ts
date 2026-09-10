export type ErrorCode = 'CONFIG' | 'TIMEOUT' | 'CLOSED' | 'PROTOCOL' | 'UNREACHABLE' | 'UNCERTAIN' | 'STOPPED' | 'BUSY';

/** Messages are deliberately independent of raw device output and credentials. */
export class PduError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'PduError';
    this.code = code;
  }
}

export function safeError(error: unknown): string {
  return error instanceof PduError ? `${error.code}: ${error.message}` : 'Unexpected internal error';
}
