import { describe, expect, it } from "vitest";
import { ClaudeConsultError } from "../../src/errors.js";
import type { ClaudeEnvelope } from "../../src/claude/parse-output.js";
import { formatFooter, toErrorResult, toSuccessResult } from "../../src/tools/tool-result.js";

const SESSION_ID = "123e4567-e89b-12d3-a456-426614174000";
const STRUCTURED_NOTICE = '[claude-consult] structured-output-notice: Claude answered in prose instead of the requested JSON. Read the answer below directly and extract what you need; if you strictly require the JSON fields, retry once with model "sonnet" or "opus", which follow output schemas more reliably.';

function envelope(overrides: Partial<ClaudeEnvelope> = {}): ClaudeEnvelope {
  return {
    result: "the answer",
    structuredOutput: undefined,
    sessionId: SESSION_ID,
    isError: false,
    subtype: undefined,
    apiErrorStatus: undefined,
    totalCostUsd: 0.12,
    durationMs: 3400,
    numTurns: 2,
    ...overrides
  };
}

describe("toSuccessResult", () => {
  it("formats the footer for aggregated tool results", () => {
    expect(formatFooter(envelope())).toBe(`[claude-consult] session_id: ${SESSION_ID} | cost_usd: 0.12 | duration_ms: 3400 | turns: 2`);
  });

  it("appends the machine-readable footer in the fixed format", () => {
    const result = toSuccessResult(envelope());
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.text).toBe(`the answer\n\n---\n[claude-consult] session_id: ${SESSION_ID} | cost_usd: 0.12 | duration_ms: 3400 | turns: 2`);
    expect(result.content[0]?.text).not.toContain("format:");
  });

  it("renders missing metrics as n/a", () => {
    const result = toSuccessResult(envelope({ totalCostUsd: undefined, durationMs: undefined, numTurns: undefined }));
    expect(result.content[0]?.text).toContain(`session_id: ${SESSION_ID} | cost_usd: n/a | duration_ms: n/a | turns: n/a`);
  });

  it("marks structured schema-compliant results as json in the footer", () => {
    const result = toSuccessResult(envelope({ result: '{"answer":"ok"}', structuredOutput: { answer: "ok" } }), { structuredExpected: true });
    expect(result.content[0]?.text).toBe(`{"answer":"ok"}\n\n---\n[claude-consult] session_id: ${SESSION_ID} | cost_usd: 0.12 | duration_ms: 3400 | turns: 2 | format: json`);
  });

  it("appends injected continuity metadata as the last footer segment", () => {
    const result = toSuccessResult({ ...envelope(), continuityInfo: { injected: true, entries: 2 } } as ClaudeEnvelope);
    expect(result.content[0]?.text).toBe(`the answer\n\n---\n[claude-consult] session_id: ${SESSION_ID} | cost_usd: 0.12 | duration_ms: 3400 | turns: 2 | continuity: injected(2)`);
  });

  it("appends continuity none only when an eligible outcome is present", () => {
    const result = toSuccessResult({ ...envelope(), continuityInfo: { injected: false, entries: 0 } } as ClaudeEnvelope);
    expect(result.content[0]?.text).toBe(`the answer\n\n---\n[claude-consult] session_id: ${SESSION_ID} | cost_usd: 0.12 | duration_ms: 3400 | turns: 2 | continuity: none`);
    expect(toSuccessResult(envelope()).content[0]?.text).not.toContain("continuity:");
  });

  it("keeps format before continuity when both footer segments are present", () => {
    const result = toSuccessResult({ ...envelope({ result: '{"answer":"ok"}', structuredOutput: { answer: "ok" } }), continuityInfo: { injected: true, entries: 1 } } as ClaudeEnvelope, { structuredExpected: true });
    expect(result.content[0]?.text).toBe(`{"answer":"ok"}\n\n---\n[claude-consult] session_id: ${SESSION_ID} | cost_usd: 0.12 | duration_ms: 3400 | turns: 2 | format: json | continuity: injected(1)`);
  });

  it("marks prose schema fallbacks and wraps the answer with the exact notice", () => {
    const result = toSuccessResult(envelope({ result: "plain answer" }), { structuredExpected: true });
    expect(result.content[0]?.text).toBe(`${STRUCTURED_NOTICE}\n\n<prose-answer>\nplain answer\n</prose-answer>\n\n---\n[claude-consult] session_id: ${SESSION_ID} | cost_usd: 0.12 | duration_ms: 3400 | turns: 2 | format: prose`);
  });
});

describe("toErrorResult", () => {
  it("renders taxonomy errors with code and hint", () => {
    const result = toErrorResult(new ClaudeConsultError("CLAUDE_TIMEOUT", "run exceeded 600000 ms", "raise the timeout"));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("[CLAUDE_TIMEOUT] run exceeded 600000 ms\nHint: raise the timeout");
  });

  it("hides details of unexpected exceptions behind INTERNAL_ERROR", () => {
    const result = toErrorResult(new Error("secret database password"));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("[INTERNAL_ERROR]");
    expect(result.content[0]?.text).not.toContain("secret database password");
  });
});
