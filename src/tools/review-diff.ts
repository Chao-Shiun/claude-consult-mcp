import { z } from "zod";
import { LIMITS } from "../constants.js";
import { ClaudeConsultError } from "../errors.js";
import { runCommand } from "../run-command.js";
import { composeAdvisorPrompt } from "./advisor-prompt.js";
import { absolutePathSchema, commonToolShape, depthSchema, promptTextSchema, type ConsultTool, type ToolContext, type ToolExecuteExtra } from "./shared-schemas.js";
import { toSuccessResult, type ToolResult } from "./tool-result.js";

const DESCRIPTION = "Have Claude review your actual code changes: the server runs read-only git in the given repository and gives Claude the diff plus read access to the surrounding files. Pass the repository root as workspace_dir. By default it reviews uncommitted changes against HEAD; pass base (a branch, tag, or commit) to review everything since that ref (base...HEAD). Use it after implementing something to get an independent cross-model review of the change itself. Claude only advises; it never modifies anything. For reviewing files without git context, use claude_review_files.";

const baseRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._\/~^@-]{0,127}$/);

const argsSchema = z.object({
  workspace_dir: absolutePathSchema,
  base: baseRefSchema.optional(),
  question: promptTextSchema.optional(),
  depth: depthSchema,
  model: commonToolShape.model,
  effort: commonToolShape.effort,
  session_id: commonToolShape.session_id
});

type CommandFailureHint = "git-missing" | "repo" | "base";

function invalid(message: string, hint: string): never {
  throw new ClaudeConsultError("INVALID_INPUT", message, hint);
}

async function runGit(cwd: string, args: readonly string[], failure: CommandFailureHint): Promise<string> {
  try {
    const result = await runCommand("git", args, { cwd });
    if (result.exitCode === 0) {
      return result.stdout;
    }
    if (failure === "base") {
      invalid(`base ref is not a valid commit: ${args[args.length - 1] ?? ""}`, "pass an existing branch, tag, or commit");
    }
    if (failure === "repo") {
      invalid("workspace_dir is not inside a git repository", "pass the repository root");
    }
    invalid(`git command failed: ${result.stderr.trim()}`, "install git and ensure it is available on PATH");
  } catch (error) {
    if (error instanceof ClaudeConsultError) {
      throw error;
    }
    invalid("git is not available on PATH", "install git and ensure it is available on PATH");
  }
}

function toPlainSuccess(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function createReviewDiffTool(toolContext: ToolContext): ConsultTool {
  return Object.freeze({
    name: "claude_review_diff",
    title: "Claude Review Diff",
    description: DESCRIPTION,
    inputSchema: {
      workspace_dir: absolutePathSchema.describe("Repository root to inspect with read-only git commands."),
      base: baseRefSchema.optional().describe("Branch, tag, or commit to compare as base...HEAD. Omit to review uncommitted changes against HEAD."),
      question: promptTextSchema.optional().describe("Optional focus for the diff review."),
      depth: depthSchema,
      model: commonToolShape.model,
      effort: commonToolShape.effort,
      session_id: commonToolShape.session_id
    },
    execute: async (rawArgs: Record<string, unknown>, extra?: ToolExecuteExtra) => {
      const args = argsSchema.parse(rawArgs);
      const insideWorkTree = await runGit(args.workspace_dir, ["rev-parse", "--is-inside-work-tree"], "repo");
      if (!insideWorkTree.includes("true")) {
        invalid("workspace_dir is not inside a git repository", "pass the repository root");
      }
      if (args.base !== undefined) {
        await runGit(args.workspace_dir, ["rev-parse", "--verify", "--end-of-options", `${args.base}^{commit}`], "base");
      }
      const diff = await runGit(args.workspace_dir, args.base === undefined ? ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "HEAD"] : ["diff", "--no-color", "--no-ext-diff", "--no-textconv", `${args.base}...HEAD`], "repo");
      const status = await runGit(args.workspace_dir, ["status", "--porcelain"], "repo");
      if (diff.trim() === "" && status.trim() === "") {
        return toPlainSuccess(`No changes to review${args.base === undefined ? "" : ` between ${args.base} and HEAD`} in ${args.workspace_dir}.`);
      }
      const diffBytes = Buffer.byteLength(diff, "utf8");
      if (diffBytes > LIMITS.diffMaxBytes) {
        invalid(`diff is ${diffBytes} bytes, exceeding the 300000-byte review limit`, "pass a nearer base or use claude_review_files on the key files");
      }
      const question = args.question ?? "Review these changes for correctness, security, and simplicity. Cite file paths and line numbers from the diff in every finding.";
      const prompt = `Review the following code changes. You may Read the surrounding files in the repository for context before judging.\n\n<git-status>\n${status.trim() === "" ? "(clean)" : status.trim()}\n</git-status>\n\n<diff>\n${diff}\n</diff>\n\n<question>\n${question}\n</question>`;
      return toSuccessResult(await toolContext.runClaude({
        prompt,
        appendSystemPrompt: composeAdvisorPrompt(),
        addDirs: [args.workspace_dir],
        cwd: args.workspace_dir,
        continuityWorkspaceDir: args.workspace_dir,
        model: args.model,
        effort: args.effort,
        sessionId: args.session_id,
        depth: args.depth,
        signal: extra?.signal,
        origin: { tool: "claude_review_diff", excerpt: args.question ?? "diff review" }
      }));
    }
  });
}
