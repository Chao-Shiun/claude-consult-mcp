import path from "node:path";
import { z } from "zod";
import { LIMITS, PATTERNS } from "../constants.js";
import type { RunClaude } from "../claude/runner.js";
import type { ToolResult } from "./tool-result.js";

export const sessionIdSchema = z.string().regex(PATTERNS.sessionId, { message: "session_id must be the UUID printed in a previous result footer" });

export const modelSchema = z.string().regex(PATTERNS.model, { message: "model must be an alias like opus, sonnet, haiku, or a full model id" });

// Cap free-text tool inputs at the schema boundary so oversized payloads are
// rejected during parsing instead of after being fully buffered and parsed.
export const promptTextSchema = z.string().min(1).max(LIMITS.promptMaxBytes, { message: `text must be at most ${LIMITS.promptMaxBytes} characters` });

export const absolutePathSchema = z.string().min(1)
  .refine((value) => path.isAbsolute(value), { message: "path must be absolute" })
  .refine((value) => !PATTERNS.uncOrDevice.test(value), { message: "UNC and device paths are not allowed" });

export const pathsSchema = z.array(absolutePathSchema).min(1).max(LIMITS.pathsMax);

export const commonToolShape = {
  workspace_dir: absolutePathSchema.optional().describe("Absolute path to the project this relates to; becomes Claude's working directory. Reuse the same value when continuing a session."),
  model: modelSchema.optional().describe("Claude model override: opus, sonnet, haiku, or a full model id. Omit for the configured default."),
  session_id: sessionIdSchema.optional().describe("session_id from a previous result footer to continue that conversation.")
};

export interface CommonToolArgs {
  readonly workspace_dir?: string | undefined;
  readonly model?: string | undefined;
  readonly session_id?: string | undefined;
}

export function toRunnerBase(args: CommonToolArgs): { model: string | undefined; sessionId: string | undefined; cwd: string | undefined } {
  return {
    model: args.model,
    sessionId: args.session_id,
    cwd: args.workspace_dir
  };
}

export interface ToolContext {
  readonly runClaude: RunClaude;
}

export interface ConsultTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodRawShape;
  readonly execute: (args: Record<string, unknown>) => Promise<ToolResult>;
}
