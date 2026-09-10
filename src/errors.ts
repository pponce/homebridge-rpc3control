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

export type ErrorReporter = (message: string) => void;

/** Reporting an error must not become another uncaught callback failure. */
export function reportError(report: ErrorReporter, context: string, error: unknown): void {
  const message = `${context}: ${safeError(error)}`;
  try { report(message); }
  catch {
    try { console.error(message); } catch { /* No remaining reporting destination. */ }
  }
}
