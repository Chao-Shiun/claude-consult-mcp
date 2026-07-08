import { stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ClaudeConsultError } from "../errors.js";
import { composeAdvisorPrompt } from "./advisor-prompt.js";
import { commonToolShape, pathsSchema, promptTextSchema, toRunnerBase, type ConsultTool, type ToolContext } from "./shared-schemas.js";
import { toSuccessResult } from "./tool-result.js";

const DESCRIPTION = "Have Claude read and analyze specific files or directories agentically (read-only: it can Read, Glob, and Grep within the granted paths, and research the web, but never modifies anything). Provide ABSOLUTE paths that exist on this machine and a focused question, e.g. 'find the race condition in this module' or 'review these files for injection vulnerabilities'. Better than pasting file contents into ask_claude for anything larger than a snippet. For verification workflows, this gives Claude an independent read of the code so its review does not depend on your summary.";

export function commonAncestor(dirs: readonly string[]): string | undefined {
  const [first, ...rest] = dirs;
  if (first === undefined) {
    return undefined;
  }
  const separator = first.includes("\\") ? "\\" : "/";
  let prefixParts = first.split(/[\\/]/);
  for (const dir of rest) {
    const parts = dir.split(/[\\/]/);
    let shared = 0;
    while (shared < prefixParts.length && shared < parts.length && prefixParts[shared]?.toLowerCase() === parts[shared]?.toLowerCase()) {
      shared += 1;
    }
    prefixParts = prefixParts.slice(0, shared);
    if (prefixParts.length === 0) {
      return undefined;
    }
  }
  const joined = prefixParts.join(separator);
  // An empty result (POSIX paths sharing only "/") or a bare drive letter
  // (Windows paths sharing only "C:") is not a meaningful ancestor. Returning
  // undefined lets the caller fall back to a specific path instead of widening
  // the working directory to a filesystem or drive root.
  if (joined === "" || /^[A-Za-z]:$/.test(joined)) {
    return undefined;
  }
  return joined;
}

const argsSchema = z.object({
  paths: pathsSchema,
  question: promptTextSchema,
  ...commonToolShape
});

interface PathInfo {
  readonly path: string;
  readonly isDirectory: boolean | undefined;
}

async function inspectPaths(paths: readonly string[]): Promise<readonly PathInfo[]> {
  return Promise.all(paths.map(async (candidate) => {
    try {
      const info = await stat(candidate);
      return { path: candidate, isDirectory: info.isDirectory() };
    } catch {
      return { path: candidate, isDirectory: undefined };
    }
  }));
}

export function createReviewFilesTool(toolContext: ToolContext): ConsultTool {
  return Object.freeze({
    name: "claude_review_files",
    title: "Claude Review Files",
    description: DESCRIPTION,
    inputSchema: {
      paths: pathsSchema.describe("Absolute paths of files or directories to analyze (1-32). Every path must exist on this machine."),
      question: promptTextSchema.describe("What to look for or evaluate in these paths."),
      ...commonToolShape
    },
    execute: async (rawArgs: Record<string, unknown>) => {
      const args = argsSchema.parse(rawArgs);
      const inspected = await inspectPaths(args.paths);
      const missing = inspected.filter((entry) => entry.isDirectory === undefined).map((entry) => entry.path);
      if (missing.length > 0) {
        throw new ClaudeConsultError("INVALID_INPUT", `paths do not exist: ${missing.join(", ")}`, "pass absolute paths that exist on this machine");
      }
      const dirs = [...new Set(inspected.map((entry) => entry.isDirectory === true ? entry.path : path.dirname(entry.path)))];
      const cwd = args.workspace_dir ?? commonAncestor(dirs) ?? dirs[0];
      const pathList = args.paths.map((entry) => `- ${entry}`).join("\n");
      const prompt = `Read and analyze the following paths from disk before answering. Use your Read, Glob, and Grep tools within the granted directories.\n\nPaths:\n${pathList}\n\n<question>\n${args.question}\n</question>`;
      return toSuccessResult(await toolContext.runClaude({ prompt, appendSystemPrompt: composeAdvisorPrompt(), addDirs: dirs, ...toRunnerBase(args), cwd }));
    }
  });
}
