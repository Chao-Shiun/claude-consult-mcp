import { describe, expect, it } from "vitest";
import { isClaudeConsultError, type ErrorCode } from "../../src/errors.js";
import { parseClaudeOutput } from "../../src/claude/parse-output.js";

const SESSION_ID = "e006b3ef-cfdd-4cc3-bbbc-5aa5c82d18a9";

const SUCCESS_ENVELOPE = `{"type":"result","subtype":"success","is_error":false,"duration_ms":5123,"num_turns":2,"result":"pong","session_id":"${SESSION_ID}","total_cost_usd":0.0512}`;

const AUTH_FAILURE_ENVELOPE = `{"type":"result","subtype":"success","is_error":true,"api_error_status":401,"duration_ms":3333,"duration_api_ms":0,"num_turns":1,"result":"Failed to authenticate. API Error: 401 Invalid authentication credentials","session_id":"${SESSION_ID}","total_cost_usd":0}`;

function expectCode(fn: () => unknown, code: ErrorCode, messagePart: string): void {
  try {
    fn();
    expect.unreachable(`expected a ${code} error`);
  } catch (error) {
    expect(isClaudeConsultError(error)).toBe(true);
    if (isClaudeConsultError(error)) {
      expect(error.code).toBe(code);
      expect(`${error.message} ${error.hint}`).toContain(messagePart);
    }
  }
}

describe("parseClaudeOutput", () => {
  it("parses a successful envelope into camelCase fields", () => {
    const envelope = parseClaudeOutput({ stdout: SUCCESS_ENVELOPE, stderrTail: "", exitCode: 0 });
    expect(envelope.result).toBe("pong");
    expect(envelope.sessionId).toBe(SESSION_ID);
    expect(envelope.isError).toBe(false);
    expect(envelope.totalCostUsd).toBe(0.0512);
    expect(envelope.durationMs).toBe(5123);
    expect(envelope.numTurns).toBe(2);
    expect(Object.isFrozen(envelope)).toBe(true);
  });

  it("tolerates null metric fields as emitted by claude 2.1.163 on success", () => {
    // Captured from a real authenticated run: success envelopes carry
    // api_error_status as JSON null rather than omitting the field.
    const nullFieldsEnvelope = `{"type":"result","subtype":"success","is_error":false,"api_error_status":null,"duration_ms":15386,"duration_api_ms":10062,"ttft_ms":12967,"time_to_request_ms":3093,"num_turns":1,"result":"ok","stop_reason":"end_turn","session_id":"${SESSION_ID}","total_cost_usd":0.2822775,"usage":{"input_tokens":18473,"output_tokens":4}}`;
    const envelope = parseClaudeOutput({ stdout: nullFieldsEnvelope, stderrTail: "", exitCode: 0 });
    expect(envelope.result).toBe("ok");
    expect(envelope.sessionId).toBe(SESSION_ID);
    expect(envelope.apiErrorStatus).toBeUndefined();
    expect(envelope.totalCostUsd).toBe(0.2822775);
    expect(envelope.numTurns).toBe(1);
  });

  it("tolerates null in every defensive envelope field", () => {
    const allNulls = `{"type":"result","subtype":null,"is_error":false,"api_error_status":null,"duration_ms":null,"num_turns":null,"result":"ok","session_id":"${SESSION_ID}","total_cost_usd":null}`;
    const envelope = parseClaudeOutput({ stdout: allNulls, stderrTail: "", exitCode: 0 });
    expect(envelope.result).toBe("ok");
    expect(envelope.subtype).toBeUndefined();
    expect(envelope.durationMs).toBeUndefined();
    expect(envelope.numTurns).toBeUndefined();
    expect(envelope.totalCostUsd).toBeUndefined();
  });

  it("normalizes json-schema structured_output into the result body", () => {
    const body = `{"type":"result","subtype":"success","is_error":false,"result":"","structured_output":{"answer":"ok"},"session_id":"${SESSION_ID}","total_cost_usd":0.01}`;
    const envelope = parseClaudeOutput({ stdout: body, stderrTail: "", exitCode: 0 });
    expect(envelope.result).toBe('{"answer":"ok"}');
  });

  it("recovers the envelope from the last non-empty line when noise precedes it", () => {
    const noisy = `Warning: no stdin data received in 3s, proceeding without it.\n${SUCCESS_ENVELOPE}\n`;
    expect(parseClaudeOutput({ stdout: noisy, stderrTail: "", exitCode: 0 }).result).toBe("pong");
  });

  it("maps the real 401 envelope to CLAUDE_NOT_AUTHENTICATED", () => {
    expectCode(() => parseClaudeOutput({ stdout: AUTH_FAILURE_ENVELOPE, stderrTail: "", exitCode: 1 }), "CLAUDE_NOT_AUTHENTICATED", "log in");
  });

  it("maps authentication text without a 401 status to CLAUDE_NOT_AUTHENTICATED", () => {
    const body = `{"type":"result","is_error":true,"result":"Invalid API key. Please run /login","session_id":"${SESSION_ID}"}`;
    expectCode(() => parseClaudeOutput({ stdout: body, stderrTail: "", exitCode: 1 }), "CLAUDE_NOT_AUTHENTICATED", "log in");
  });

  it("maps a missing conversation to SESSION_NOT_FOUND", () => {
    const body = `{"type":"result","is_error":true,"result":"No conversation found with session ID: ${SESSION_ID}","session_id":"${SESSION_ID}"}`;
    expectCode(() => parseClaudeOutput({ stdout: body, stderrTail: "", exitCode: 1 }), "SESSION_NOT_FOUND", "workspace_dir");
  });

  it("maps other envelope errors to CLAUDE_RESULT_ERROR with the subtype", () => {
    const body = `{"type":"result","subtype":"error_during_execution","is_error":true,"result":"budget exceeded","session_id":"${SESSION_ID}"}`;
    expectCode(() => parseClaudeOutput({ stdout: body, stderrTail: "", exitCode: 1 }), "CLAUDE_RESULT_ERROR", "error_during_execution");
  });

  it("maps configured budget cap aborts to an actionable result error", () => {
    const body = `{"type":"result","subtype":"error_max_budget_usd","is_error":true,"result":"","session_id":"${SESSION_ID}"}`;
    expectCode(() => parseClaudeOutput({ stdout: body, stderrTail: "", exitCode: 1 }), "CLAUDE_RESULT_ERROR", "raise or unset CLAUDE_CONSULT_MAX_BUDGET_USD");
  });

  it("maps unparseable stdout with a nonzero exit to CLAUDE_NONZERO_EXIT including the stderr tail", () => {
    expectCode(() => parseClaudeOutput({ stdout: "not json at all", stderrTail: "boom from stderr", exitCode: 2 }), "CLAUDE_NONZERO_EXIT", "boom from stderr");
  });

  it("maps empty stdout with a nonzero exit to CLAUDE_NONZERO_EXIT with the exit code", () => {
    expectCode(() => parseClaudeOutput({ stdout: "", stderrTail: "", exitCode: 3 }), "CLAUDE_NONZERO_EXIT", "3");
  });

  it("maps unparseable stdout with exit 0 to CLAUDE_MALFORMED_OUTPUT with a sample", () => {
    expectCode(() => parseClaudeOutput({ stdout: "plain text answer", stderrTail: "", exitCode: 0 }), "CLAUDE_MALFORMED_OUTPUT", "plain text answer");
  });

  it("maps empty stdout with exit 0 to CLAUDE_MALFORMED_OUTPUT", () => {
    expectCode(() => parseClaudeOutput({ stdout: "   ", stderrTail: "", exitCode: 0 }), "CLAUDE_MALFORMED_OUTPUT", "empty");
  });

  it("rejects an envelope missing the session id", () => {
    const body = `{"type":"result","is_error":false,"result":"pong"}`;
    expectCode(() => parseClaudeOutput({ stdout: body, stderrTail: "", exitCode: 0 }), "CLAUDE_MALFORMED_OUTPUT", "session_id");
  });

  it("trusts a valid success envelope even when the exit code is null", () => {
    expect(parseClaudeOutput({ stdout: SUCCESS_ENVELOPE, stderrTail: "", exitCode: null }).result).toBe("pong");
  });
});
