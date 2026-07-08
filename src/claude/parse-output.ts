import { z } from "zod";
import { ENV, LIMITS } from "../constants.js";
import { ClaudeConsultError } from "../errors.js";

export interface RawRunOutput {
  readonly stdout: string;
  readonly stderrTail: string;
  readonly exitCode: number | null;
}

export interface ClaudeEnvelope {
  readonly result: string;
  readonly sessionId: string;
  readonly isError: boolean;
  readonly subtype: string | undefined;
  readonly apiErrorStatus: number | undefined;
  readonly totalCostUsd: number | undefined;
  readonly durationMs: number | undefined;
  readonly numTurns: number | undefined;
}

const nullableNumberSchema = z.number().nullish();

const envelopeSchema = z.object({
  result: z.string().optional(),
  session_id: z.string().optional(),
  is_error: z.boolean().optional(),
  subtype: z.string().nullish(),
  api_error_status: nullableNumberSchema,
  total_cost_usd: nullableNumberSchema,
  duration_ms: nullableNumberSchema,
  num_turns: nullableNumberSchema
}).passthrough();

const AUTH_PATTERN = /failed to authenticate|invalid authentication|invalid api key|please run \/login/i;
const SESSION_PATTERN = /no conversation found/i;

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractCandidate(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed === "") {
    return undefined;
  }
  const whole = tryParseJson(trimmed);
  if (whole !== undefined) {
    return whole;
  }
  const lines = trimmed.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const lastLine = lines[lines.length - 1];
  return lastLine === undefined ? undefined : tryParseJson(lastLine);
}

function throwUnparseable(raw: RawRunOutput): never {
  const trimmed = raw.stdout.trim();
  if (raw.exitCode === 0) {
    if (trimmed === "") {
      throw new ClaudeConsultError("CLAUDE_MALFORMED_OUTPUT", "claude produced empty stdout", "run `claude --version` to verify the installation");
    }
    throw new ClaudeConsultError("CLAUDE_MALFORMED_OUTPUT", `claude stdout was not the expected JSON envelope: ${trimmed.slice(0, LIMITS.stdoutSampleChars)}`, "run `claude --version`; the JSON envelope shape may have changed in a newer CLI");
  }
  const stderrSnippet = raw.stderrTail.slice(-LIMITS.stderrSnippetChars);
  throw new ClaudeConsultError("CLAUDE_NONZERO_EXIT", `claude exited with code ${raw.exitCode} without a parseable result; stderr tail: ${stderrSnippet}`, `raise ${ENV.timeoutMs} if the run was slow, or run \`claude --version\` to verify the installation`);
}

function throwEnvelopeError(data: z.infer<typeof envelopeSchema>): never {
  const text = data.result ?? "";
  if (data.subtype === "error_max_budget_usd") {
    throw new ClaudeConsultError("CLAUDE_RESULT_ERROR", "claude aborted the run because it exceeded the configured budget cap before finishing", "raise or unset CLAUDE_CONSULT_MAX_BUDGET_USD on this machine; subscription logins have no marginal cost to cap, and spend incurred before the abort is already consumed");
  }
  if (data.api_error_status === 401 || AUTH_PATTERN.test(text)) {
    throw new ClaudeConsultError("CLAUDE_NOT_AUTHENTICATED", `claude is not authenticated: ${text}`, "run `claude` interactively once on this machine to log in");
  }
  if (SESSION_PATTERN.test(text)) {
    throw new ClaudeConsultError("SESSION_NOT_FOUND", text, "pass the same workspace_dir as the original call so the session can be found");
  }
  const subtype = data.subtype ? ` (${data.subtype})` : "";
  throw new ClaudeConsultError("CLAUDE_RESULT_ERROR", `claude reported an error${subtype}: ${text}`, "read the error text and adjust the request");
}

export function parseClaudeOutput(raw: RawRunOutput): ClaudeEnvelope {
  const candidate = extractCandidate(raw.stdout);
  if (candidate === undefined) {
    throwUnparseable(raw);
  }
  const parsed = envelopeSchema.safeParse(candidate);
  if (!parsed.success) {
    throwUnparseable(raw);
  }
  const data = parsed.data;
  if (data.is_error === true) {
    throwEnvelopeError(data);
  }
  if (typeof data.result !== "string" || typeof data.session_id !== "string") {
    throw new ClaudeConsultError("CLAUDE_MALFORMED_OUTPUT", "claude envelope is missing result or session_id", "run `claude --version`; the JSON envelope shape may have changed in a newer CLI");
  }
  return Object.freeze({
    result: data.result,
    sessionId: data.session_id,
    isError: false,
    subtype: data.subtype ?? undefined,
    apiErrorStatus: data.api_error_status ?? undefined,
    totalCostUsd: data.total_cost_usd ?? undefined,
    durationMs: data.duration_ms ?? undefined,
    numTurns: data.num_turns ?? undefined
  });
}
