import { FOOTER_PREFIX } from "../constants.js";
import { toDisplayText, toInternalError } from "../errors.js";
import type { ClaudeEnvelope } from "../claude/parse-output.js";

export interface ToolResultContent {
  readonly type: "text";
  readonly text: string;
}

export interface ToolResult {
  readonly content: ToolResultContent[];
  readonly isError?: boolean;
  readonly [key: string]: unknown;
}

export interface SuccessResultOptions {
  readonly structuredExpected?: boolean;
}

export const STRUCTURED_OUTPUT_NOTICE = '[claude-consult] structured-output-notice: Claude answered in prose instead of the requested JSON. Read the answer below directly and extract what you need; if you strictly require the JSON fields, retry once with model "sonnet" or "opus", which follow output schemas more reliably.';
export const STRUCTURED_FORMAT_DESCRIPTION = 'Check the result footer\'s format field before parsing: format: json means the body is the requested JSON document; format: prose means Claude answered in prose instead - read it directly or retry with a stronger model rather than calling JSON.parse blindly.';

function formatMetric(value: number | undefined): string {
  return value === undefined ? "n/a" : String(value);
}

function structuredFormat(envelope: ClaudeEnvelope, options: SuccessResultOptions | undefined): "json" | "prose" | undefined {
  if (options?.structuredExpected !== true) {
    return undefined;
  }
  return envelope.structuredOutput !== undefined ? "json" : "prose";
}

export function formatFooter(envelope: ClaudeEnvelope, options?: SuccessResultOptions): string {
  const base = `${FOOTER_PREFIX} session_id: ${envelope.sessionId} | cost_usd: ${formatMetric(envelope.totalCostUsd)} | duration_ms: ${formatMetric(envelope.durationMs)} | turns: ${formatMetric(envelope.numTurns)}`;
  const format = structuredFormat(envelope, options);
  return format === undefined ? base : `${base} | format: ${format}`;
}

export function toSuccessResult(envelope: ClaudeEnvelope, options?: SuccessResultOptions): ToolResult {
  const format = structuredFormat(envelope, options);
  const body = format === "prose"
    ? `${STRUCTURED_OUTPUT_NOTICE}\n\n<prose-answer>\n${envelope.result}\n</prose-answer>`
    : envelope.result;
  const footer = formatFooter(envelope, options);
  return { content: [{ type: "text", text: `${body}\n\n---\n${footer}` }] };
}

export function toErrorResult(error: unknown): ToolResult {
  return { isError: true, content: [{ type: "text", text: toDisplayText(toInternalError(error)) }] };
}
