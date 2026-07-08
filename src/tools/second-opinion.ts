import { z } from "zod";
import { composeAdvisorPrompt } from "./advisor-prompt.js";
import { commonToolShape, promptTextSchema, toRunnerBase, type ConsultTool, type ToolContext } from "./shared-schemas.js";
import { toSuccessResult } from "./tool-result.js";

export const CRITICAL_REVIEWER_PROMPT = [
  "You are a critical second reviewer. Another AI coding agent produced the analysis under review.",
  "Your job is to find what is wrong or missing, not to be agreeable.",
  "Verify technical claims, challenge assumptions, and look for missed edge cases, concurrency and security issues, and simpler alternatives.",
  "Agree only after genuine verification, and even then state the strongest remaining risk.",
  "Structure your reply with these sections: Verdict (agree / partially agree / disagree), Flaws found, Missed considerations, Suggested changes, Confidence."
].join(" ");

const DESCRIPTION = "Get an adversarial review of YOUR OWN analysis, plan, or conclusion before committing to it. Claude is explicitly instructed to hunt for flaws, wrong assumptions, missed edge cases, and simpler alternatives rather than agree. Use before risky changes, migrations, security-sensitive edits, or when your confidence is low. Provide the problem and your full reasoning - the more you show, the better the critique. Claude only critiques; it never modifies files.";

const argsSchema = z.object({
  problem: promptTextSchema,
  analysis: promptTextSchema,
  ...commonToolShape
});

export function createSecondOpinionTool(toolContext: ToolContext): ConsultTool {
  return Object.freeze({
    name: "claude_second_opinion",
    title: "Claude Second Opinion",
    description: DESCRIPTION,
    inputSchema: {
      problem: promptTextSchema.describe("Neutral statement of the problem or task being solved."),
      analysis: promptTextSchema.describe("Your analysis, conclusion, or plan to be critiqued - include the reasoning, not just the answer."),
      ...commonToolShape
    },
    execute: async (rawArgs: Record<string, unknown>) => {
      const args = argsSchema.parse(rawArgs);
      const prompt = `Another AI coding agent (OpenAI Codex) asks for an adversarial second opinion.\n\n<problem>\n${args.problem}\n</problem>\n\n<analysis-under-review>\n${args.analysis}\n</analysis-under-review>\n\nCritique the analysis as instructed in your system prompt.`;
      return toSuccessResult(await toolContext.runClaude({ prompt, appendSystemPrompt: composeAdvisorPrompt(CRITICAL_REVIEWER_PROMPT), addDirs: [], ...toRunnerBase(args) }));
    }
  });
}
