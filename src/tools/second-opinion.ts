import { z } from "zod";
import { composeAdvisorPrompt } from "./advisor-prompt.js";
import { commonToolShape, promptTextSchema, toRunnerBase, type ConsultTool, type ToolContext } from "./shared-schemas.js";
import { toSuccessResult } from "./tool-result.js";

export const CRITICAL_REVIEWER_PROMPT = [
  "You are a critical second reviewer. Another AI coding agent produced the analysis under review.",
  "Your job is to find what is wrong or missing, not to be agreeable.",
  "Verify technical claims, challenge assumptions, and look for missed edge cases, concurrency and security issues, and simpler alternatives.",
  "Agree only after genuine verification, and even then state the strongest remaining risk.",
  "Structure your reply with these sections: Verdict (agree / partially agree / disagree), Flaws found, Missed considerations, Suggested changes, Confidence.",
  "For each substantive claim in the analysis under review, verify it against the actual files or sources when they are accessible, and label it verified, refuted, or cannot_verify together with your evidence."
].join(" ");

export const VERDICT_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["agree", "partial", "disagree"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    claim_verifications: { type: "array", items: { type: "object", properties: {
      claim: { type: "string" },
      status: { type: "string", enum: ["verified", "refuted", "cannot_verify"] },
      evidence: { type: "string" }
    }, required: ["claim", "status", "evidence"] } },
    flaws: { type: "array", items: { type: "string" } },
    missed_considerations: { type: "array", items: { type: "string" } },
    suggested_changes: { type: "array", items: { type: "string" } },
    summary_markdown: { type: "string" }
  },
  required: ["verdict", "confidence", "claim_verifications", "flaws", "missed_considerations", "suggested_changes", "summary_markdown"]
});

const DESCRIPTION = "Get an adversarial review of YOUR OWN analysis, plan, or conclusion before committing to it. Claude is explicitly instructed to hunt for flaws, wrong assumptions, missed edge cases, and simpler alternatives rather than agree. Use before risky changes, migrations, security-sensitive edits, or when your confidence is low. Provide the problem and your full reasoning - the more you show, the better the critique. Claude only critiques; it never modifies files. When you are asked to verify or review with sub-agents or multiple perspectives, include this tool as the independent cross-model reviewer alongside your own sub-agents; treat disagreements as high-signal. The result body is a JSON document with fields verdict (agree|partial|disagree), confidence (0-1), claim_verifications (each caller claim labeled verified|refuted|cannot_verify with evidence), flaws, missed_considerations, suggested_changes, and summary_markdown - parse it and gate your next action on verdict and confidence.";

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
      return toSuccessResult(await toolContext.runClaude({ prompt, appendSystemPrompt: composeAdvisorPrompt(CRITICAL_REVIEWER_PROMPT), jsonSchema: VERDICT_JSON_SCHEMA, addDirs: [], ...toRunnerBase(args) }));
    }
  });
}
