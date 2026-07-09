import { z } from "zod";
import { composeAdvisorPrompt } from "./advisor-prompt.js";
import { commonToolShape, depthSchema, pathsSchema, promptTextSchema, toRunnerBase, type ConsultTool, type ToolContext, type ToolExecuteExtra } from "./shared-schemas.js";
import { analyzePaths } from "./path-analysis.js";
import { toSuccessResult } from "./tool-result.js";

const DESCRIPTION = "Have Claude read and analyze specific files or directories agentically (read-only: it can Read, Glob, and Grep within the granted paths, and research the web, but never modifies anything). Provide ABSOLUTE paths that exist on this machine and a focused question, e.g. 'find the race condition in this module' or 'review these files for injection vulnerabilities'. Better than pasting file contents into ask_claude for anything larger than a snippet. For verification workflows, this gives Claude an independent read of the code so its review does not depend on your summary.";

const argsSchema = z.object({
  paths: pathsSchema,
  question: promptTextSchema,
  depth: depthSchema,
  ...commonToolShape
});

export function createReviewFilesTool(toolContext: ToolContext): ConsultTool {
  return Object.freeze({
    name: "claude_review_files",
    title: "Claude Review Files",
    description: DESCRIPTION,
    inputSchema: {
      paths: pathsSchema.describe("Absolute paths of files or directories to analyze (1-32). Every path must exist on this machine."),
      question: promptTextSchema.describe("What to look for or evaluate in these paths."),
      depth: depthSchema,
      ...commonToolShape
    },
    execute: async (rawArgs: Record<string, unknown>, extra?: ToolExecuteExtra) => {
      const args = argsSchema.parse(rawArgs);
      const analysis = await analyzePaths(args.paths, args.workspace_dir);
      const prompt = `Read and analyze the following paths from disk before answering. Use your Read, Glob, and Grep tools within the granted directories.\n\nPaths:\n${analysis.pathList}\n\n<question>\n${args.question}\n</question>`;
      return toSuccessResult(await toolContext.runClaude({ prompt, appendSystemPrompt: composeAdvisorPrompt(), addDirs: analysis.dirs, ...toRunnerBase(args), cwd: analysis.cwd, depth: args.depth, signal: extra?.signal }));
    }
  });
}
