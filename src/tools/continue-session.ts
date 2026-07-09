import { z } from "zod";
import { composeAdvisorPrompt } from "./advisor-prompt.js";
import { CRITICAL_REVIEWER_PROMPT } from "./second-opinion.js";
import { commonToolShape, promptTextSchema, sessionIdSchema, toRunnerBase, type ConsultTool, type ToolContext, type ToolExecuteExtra } from "./shared-schemas.js";
import { toSuccessResult } from "./tool-result.js";

const DESCRIPTION = "Continue an existing Claude conversation. Pass the session_id printed at the end of a previous result plus your follow-up message. Use the same workspace_dir as the original call, or the session will not be found.";

const argsSchema = z.object({
  session_id: sessionIdSchema,
  message: promptTextSchema,
  workspace_dir: commonToolShape.workspace_dir,
  model: commonToolShape.model,
  stance: z.enum(["neutral", "critical"]).optional().describe("Set to \"critical\" when continuing an adversarial review or debate so Claude keeps its reviewer discipline instead of drifting agreeable.")
});

export function createContinueSessionTool(toolContext: ToolContext): ConsultTool {
  return Object.freeze({
    name: "claude_continue",
    title: "Continue Claude Session",
    description: DESCRIPTION,
    inputSchema: {
      session_id: sessionIdSchema.describe("The session_id printed at the end of a previous result."),
      message: promptTextSchema.describe("Your follow-up message for the same conversation."),
      workspace_dir: commonToolShape.workspace_dir,
      model: commonToolShape.model,
      stance: z.enum(["neutral", "critical"]).optional().describe("Set to \"critical\" when continuing an adversarial review or debate so Claude keeps its reviewer discipline instead of drifting agreeable.")
    },
    execute: async (rawArgs: Record<string, unknown>, extra?: ToolExecuteExtra) => {
      const args = argsSchema.parse(rawArgs);
      const appendSystemPrompt = args.stance === "critical" ? composeAdvisorPrompt(CRITICAL_REVIEWER_PROMPT) : composeAdvisorPrompt();
      return toSuccessResult(await toolContext.runClaude({ prompt: args.message, appendSystemPrompt, addDirs: [], ...toRunnerBase({ ...args, session_id: args.session_id }), signal: extra?.signal, origin: { tool: "claude_continue", excerpt: args.message } }));
    }
  });
}
