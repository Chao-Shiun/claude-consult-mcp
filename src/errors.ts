export const ERROR_CODES = Object.freeze([
  "CLAUDE_NOT_FOUND",
  "CLAUDE_NOT_AUTHENTICATED",
  "CLAUDE_SPAWN_FAILED",
  "CLAUDE_TIMEOUT",
  "CLAUDE_NONZERO_EXIT",
  "CLAUDE_MALFORMED_OUTPUT",
  "CLAUDE_RESULT_ERROR",
  "SESSION_NOT_FOUND",
  "INVALID_INPUT",
  "OUTPUT_TOO_LARGE",
  "INTERNAL_ERROR"
] as const);

export type ErrorCode = (typeof ERROR_CODES)[number];

export class ClaudeConsultError extends Error {
  readonly code: ErrorCode;
  readonly hint: string;

  constructor(code: ErrorCode, message: string, hint: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ClaudeConsultError";
    this.code = code;
    this.hint = hint;
    Object.freeze(this);
  }
}

export function isClaudeConsultError(value: unknown): value is ClaudeConsultError {
  return value instanceof ClaudeConsultError;
}

export function toDisplayText(error: ClaudeConsultError): string {
  return `[${error.code}] ${error.message}\nHint: ${error.hint}`;
}

export function toInternalError(cause: unknown): ClaudeConsultError {
  if (isClaudeConsultError(cause)) {
    return cause;
  }
  return new ClaudeConsultError("INTERNAL_ERROR", "an unexpected internal error occurred", "check the server stderr log for details", { cause });
}
