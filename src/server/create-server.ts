import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_NAME, VERSION } from "../constants.js";
import type { Logger } from "../logger.js";
import type { RunClaude } from "../claude/runner.js";
import { createAskClaudeTool } from "../tools/ask-claude.js";
import { createContinueSessionTool } from "../tools/continue-session.js";
import { createReviewFilesTool } from "../tools/review-files.js";
import { createSecondOpinionTool } from "../tools/second-opinion.js";
import type { ConsultTool, ToolContext } from "../tools/shared-schemas.js";
import { toErrorResult, toSuccessResult } from "./tool-result.js";

export interface ServerDeps {
  readonly runClaude: RunClaude;
  readonly logger: Logger;
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION });
  const context: ToolContext = { runClaude: deps.runClaude };
  const tools: readonly ConsultTool[] = [
    createAskClaudeTool(context),
    createSecondOpinionTool(context),
    createReviewFilesTool(context),
    createContinueSessionTool(context)
  ];
  for (const tool of tools) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema
    }, async (args: Record<string, unknown>) => {
      try {
        const envelope = await tool.execute(args);
        deps.logger.info(`tool ${tool.name} completed (session ${envelope.sessionId})`);
        return toSuccessResult(envelope);
      } catch (error) {
        deps.logger.error(`tool ${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`);
        return toErrorResult(error);
      }
    });
  }
  return server;
}
