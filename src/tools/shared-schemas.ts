import path from "node:path";
import { z } from "zod";
import { EFFORT_LEVELS, LIMITS, PATTERNS, type Effort } from "../constants.js";
import type { RunClaude } from "../claude/runner.js";
import type { ToolResult } from "./tool-result.js";

export const sessionIdSchema = z.string().regex(PATTERNS.sessionId, { message: "session_id must be the UUID printed in a previous result footer" });

export const modelSchema = z.string().regex(PATTERNS.model, { message: "model must be an alias like opus, sonnet, haiku, or a full model id" });
export const effortSchema = z.enum(EFFORT_LEVELS);

// Cap free-text tool inputs at the schema boundary so oversized payloads are
// rejected during parsing instead of after being fully buffered and parsed.
export const promptTextSchema = z.string().min(1).max(LIMITS.promptMaxBytes, { message: `text must be at most ${LIMITS.promptMaxBytes} characters` });

export const absolutePathSchema = z.string().min(1)
  .refine((value) => path.isAbsolute(value), { message: "path must be absolute" })
  .refine((value) => !PATTERNS.uncOrDevice.test(value), { message: "UNC and device paths are not allowed" });

export const pathsSchema = z.array(absolutePathSchema).min(1).max(LIMITS.pathsMax);

export const depthSchema = z.enum(["standard", "deep"]).optional()
  .describe("deep lets Claude delegate read-only exploration to sub-agents for large scopes - slower and several times the usage; requires the machine to enable CLAUDE_CONSULT_CAPABILITY=deep-research.");

export const commonToolShape = {
  workspace_dir: absolutePathSchema.optional().describe("Absolute path to the project this relates to; becomes Claude's working directory. Reuse the same value when continuing a session. Pass it on fresh conversations to enable journal continuity (recent-consultation context for this workspace)."),
  model: modelSchema.optional().describe("Claude model override: opus, sonnet, haiku, or a full model id. Omit for the configured default."),
  effort: effortSchema.optional().describe("Claude effort override: lower is faster and cheaper, higher is deeper reasoning; subject to the server's configured ceiling. Omit to use the model's default."),
  session_id: sessionIdSchema.optional().describe("session_id from a previous result footer to continue that conversation."),
  continuity: z.boolean().optional().describe("Set false to run without the recent-consultations digest (clean context). Cannot enable continuity when the machine owner disabled it or when the run resumes a session.")
};

export interface CommonToolArgs {
  readonly workspace_dir?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: Effort | undefined;
  readonly session_id?: string | undefined;
  readonly continuity?: boolean | undefined;
}

export type AnalysisDepth = z.infer<typeof depthSchema>;

export function toRunnerBase(args: CommonToolArgs): { model: string | undefined; effort: Effort | undefined; sessionId: string | undefined; cwd: string | undefined; continuityWorkspaceDir: string | undefined; skipContinuity: boolean } {
  return {
    model: args.model,
    effort: args.effort,
    sessionId: args.session_id,
    cwd: args.workspace_dir,
    continuityWorkspaceDir: args.workspace_dir,
    skipContinuity: args.continuity === false
  };
}

export interface ToolContext {
  readonly runClaude: RunClaude;
}

export interface ToolExecuteExtra {
  readonly signal?: AbortSignal | undefined;
}

export interface ConsultTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodRawShape;
  readonly execute: (args: Record<string, unknown>, extra?: ToolExecuteExtra) => Promise<ToolResult>;
}
