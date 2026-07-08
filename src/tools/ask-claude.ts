import { z } from "zod";
import { composeAdvisorPrompt } from "./advisor-prompt.js";
import { commonToolShape, promptTextSchema, toRunnerBase, type ConsultTool, type ToolContext } from "./shared-schemas.js";
import { toSuccessResult } from "./tool-result.js";

const DESCRIPTION = "Ask Claude Code (Anthropic's coding agent) for co-analysis, a second perspective, or knowledge you are unsure about. Use it for architecture trade-offs, tricky bugs, unfamiliar APIs, or whenever an independent expert view would help. Claude is advisory only: it reads and researches but never modifies files; you implement any changes yourself. The result ends with a session_id line - pass it to claude_continue (or any other tool here) to keep the same conversation going. If your question is about specific files on disk, prefer claude_review_files. For a structured multi-perspective review in one call, prefer claude_panel.";

const argsSchema = z.object({
  question: promptTextSchema,
  context: promptTextSchema.optional(),
  ...commonToolShape
});

export function createAskClaudeTool(toolContext: ToolContext): ConsultTool {
  return Object.freeze({
    name: "ask_claude",
    title: "Ask Claude",
    description: DESCRIPTION,
    inputSchema: {
      question: promptTextSchema.describe("The question or problem to analyze. Be specific."),
      context: promptTextSchema.optional().describe("Background: what you tried, constraints, relevant snippets."),
      ...commonToolShape
    },
    execute: async (rawArgs: Record<string, unknown>) => {
      const args = argsSchema.parse(rawArgs);
      const prompt = args.context === undefined ? args.question : `<background-context>\n${args.context}\n</background-context>\n\n${args.question}`;
      return toSuccessResult(await toolContext.runClaude({ prompt, appendSystemPrompt: composeAdvisorPrompt(), addDirs: [], ...toRunnerBase(args) }));
    }
  });
}
