import { z } from "zod";
import { composeAdvisorPrompt } from "./advisor-prompt.js";
import { commonToolShape, promptTextSchema, sessionIdSchema, toRunnerBase, type ConsultTool, type ToolContext } from "./shared-schemas.js";
import { toSuccessResult } from "./tool-result.js";

const DESCRIPTION = "Continue an existing Claude conversation. Pass the session_id printed at the end of a previous result plus your follow-up message. Use the same workspace_dir as the original call, or the session will not be found.";

const argsSchema = z.object({
  session_id: sessionIdSchema,
  message: promptTextSchema,
  workspace_dir: commonToolShape.workspace_dir,
  model: commonToolShape.model
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
      model: commonToolShape.model
    },
    execute: async (rawArgs: Record<string, unknown>) => {
      const args = argsSchema.parse(rawArgs);
      return toSuccessResult(await toolContext.runClaude({ prompt: args.message, appendSystemPrompt: composeAdvisorPrompt(), addDirs: [], ...toRunnerBase({ ...args, session_id: args.session_id }) }));
    }
  });
}
