import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_NAME, VERSION } from "../constants.js";
import type { Logger } from "../logger.js";
import type { RunClaude } from "../claude/runner.js";
import type { Journal } from "../journal.js";
import type { SessionLedger } from "../session-ledger.js";
import { createAskClaudeTool } from "../tools/ask-claude.js";
import { createContinueSessionTool } from "../tools/continue-session.js";
import { createDebateOpenTool, createDebateReplyTool } from "../tools/debate.js";
import { createPanelTool } from "../tools/panel.js";
import { createReviewDiffTool } from "../tools/review-diff.js";
import { createReviewFilesTool } from "../tools/review-files.js";
import { createSecondOpinionTool } from "../tools/second-opinion.js";
import { createSessionsTool } from "../tools/sessions.js";
import type { ConsultTool, ToolContext } from "../tools/shared-schemas.js";
import { toErrorResult } from "../tools/tool-result.js";

export interface ServerDeps {
  readonly runClaude: RunClaude;
  readonly logger: Logger;
  readonly progressHeartbeatMs?: number;
  readonly ledger?: SessionLedger | undefined;
  readonly journal?: Journal | undefined;
}

export const SERVER_INSTRUCTIONS = [
  "claude-consult-mcp exposes Claude Code (Anthropic's coding agent) as an independent cross-model advisor.",
  "Claude is advisory only: it reads files and researches, but never modifies anything; the caller implements all changes.",
  "When the user asks to verify, review, or validate work - especially with sub-agents or multiple perspectives - include Claude as an independent cross-model reviewer: call claude_second_opinion for plans or conclusions, claude_review_files for code on disk, or claude_panel for a one-call multi-perspective review.",
  "Treat disagreements between Claude and your own analysis or sub-agents as high-signal; investigate before dismissing either side.",
  "Every successful result ends with a session_id footer; pass it to claude_continue to keep the same conversation going.",
  "For long tasks, open one conversation early with ask_claude and keep using claude_continue so Claude accumulates context. After a critique, rebut or concede with claude_continue using stance \"critical\" - one evidence-based rebuttal round materially improves conclusions. claude_review_diff reviews your actual changes; claude_second_opinion returns machine-readable JSON you can gate your next action on.",
  "When Claude returns questions (a 'Questions for you:' section or questions_for_caller in JSON), answer them via claude_continue instead of abandoning the thread."
].join(" ");

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const progressHeartbeatMs = Math.max(50, deps.progressHeartbeatMs ?? 10_000);
  const context: ToolContext = { runClaude: deps.runClaude };
  const tools: readonly ConsultTool[] = [
    createAskClaudeTool(context),
    createSecondOpinionTool(context),
    createDebateOpenTool(context),
    createDebateReplyTool(context),
    createPanelTool(context),
    createReviewFilesTool(context),
    createReviewDiffTool(context),
    createContinueSessionTool(context),
    ...(deps.ledger === undefined ? [] : [createSessionsTool(deps.ledger)])
  ];
  for (const tool of tools) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema
    }, async (args: Record<string, unknown>, extra) => {
      const progressToken = extra._meta?.progressToken;
      const started = Date.now();
      const heartbeat = progressToken === undefined ? undefined : setInterval(() => {
        const elapsed = Math.max(1, Math.floor((Date.now() - started) / 1000));
        void extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: elapsed,
            message: `${tool.name} running (${elapsed}s elapsed)`
          }
        }).catch((error: unknown) => {
          deps.logger.debug(`tool ${tool.name} progress notification failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, progressHeartbeatMs);
      try {
        const result = await tool.execute(args, { signal: extra.signal });
        deps.logger.info(`tool ${tool.name} completed`);
        return result;
      } catch (error) {
        deps.logger.error(`tool ${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`);
        return toErrorResult(error);
      } finally {
        if (heartbeat !== undefined) {
          clearInterval(heartbeat);
        }
      }
    });
  }
  return server;
}
