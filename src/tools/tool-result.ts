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

function formatMetric(value: number | undefined): string {
  return value === undefined ? "n/a" : String(value);
}

export function formatFooter(envelope: ClaudeEnvelope): string {
  return `${FOOTER_PREFIX} session_id: ${envelope.sessionId} | cost_usd: ${formatMetric(envelope.totalCostUsd)} | duration_ms: ${formatMetric(envelope.durationMs)} | turns: ${formatMetric(envelope.numTurns)}`;
}

export function toSuccessResult(envelope: ClaudeEnvelope): ToolResult {
  const footer = formatFooter(envelope);
  return { content: [{ type: "text", text: `${envelope.result}\n\n---\n${footer}` }] };
}

export function toErrorResult(error: unknown): ToolResult {
  return { isError: true, content: [{ type: "text", text: toDisplayText(toInternalError(error)) }] };
}
