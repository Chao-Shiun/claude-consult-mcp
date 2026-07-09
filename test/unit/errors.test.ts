import { describe, expect, it } from "vitest";
import { ClaudeConsultError, ERROR_CODES, isClaudeConsultError, toDisplayText, toInternalError } from "../../src/errors.js";

describe("errors", () => {
  it("defines the full error taxonomy from the plan", () => {
    expect(ERROR_CODES).toEqual([
      "CLAUDE_NOT_FOUND",
      "CLAUDE_NOT_AUTHENTICATED",
      "CLAUDE_SPAWN_FAILED",
      "CLAUDE_TIMEOUT",
      "REQUEST_CANCELLED",
      "CLAUDE_NONZERO_EXIT",
      "CLAUDE_MALFORMED_OUTPUT",
      "CLAUDE_RESULT_ERROR",
      "SESSION_NOT_FOUND",
      "INVALID_INPUT",
      "OUTPUT_TOO_LARGE",
      "INTERNAL_ERROR"
    ]);
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
  });

  it("constructs an immutable error carrying code, message, and hint", () => {
    const error = new ClaudeConsultError("CLAUDE_TIMEOUT", "run exceeded 600000 ms", "raise CLAUDE_CONSULT_TIMEOUT_MS");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ClaudeConsultError");
    expect(error.code).toBe("CLAUDE_TIMEOUT");
    expect(error.message).toBe("run exceeded 600000 ms");
    expect(error.hint).toBe("raise CLAUDE_CONSULT_TIMEOUT_MS");
    expect(Object.isFrozen(error)).toBe(true);
  });

  it("renders display text as code, message, and hint lines", () => {
    const error = new ClaudeConsultError("INVALID_INPUT", "paths do not exist: C:\\missing", "pass absolute paths that exist on this machine");
    expect(toDisplayText(error)).toBe("[INVALID_INPUT] paths do not exist: C:\\missing\nHint: pass absolute paths that exist on this machine");
  });

  it("identifies its own errors with the type guard", () => {
    const error = new ClaudeConsultError("INTERNAL_ERROR", "boom", "retry");
    expect(isClaudeConsultError(error)).toBe(true);
    expect(isClaudeConsultError(new Error("boom"))).toBe(false);
    expect(isClaudeConsultError(null)).toBe(false);
    expect(isClaudeConsultError("boom")).toBe(false);
  });

  it("wraps unexpected exceptions without leaking their message", () => {
    const cause = new Error("secret internal detail");
    const wrapped = toInternalError(cause);
    expect(wrapped.code).toBe("INTERNAL_ERROR");
    expect(wrapped.message).not.toContain("secret internal detail");
    expect(wrapped.cause).toBe(cause);
  });

  it("passes through errors that are already ClaudeConsultError", () => {
    const original = new ClaudeConsultError("CLAUDE_NOT_FOUND", "claude not found", "install it");
    expect(toInternalError(original)).toBe(original);
  });

  it("wraps non-Error throwables", () => {
    const wrapped = toInternalError("plain string failure");
    expect(wrapped.code).toBe("INTERNAL_ERROR");
    expect(isClaudeConsultError(wrapped)).toBe(true);
  });
});
