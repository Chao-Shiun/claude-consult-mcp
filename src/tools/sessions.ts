import { z } from "zod";
import type { SessionEntry, SessionLedger } from "../session-ledger.js";
import { absolutePathSchema, type ConsultTool } from "./shared-schemas.js";
import type { ToolResult } from "./tool-result.js";

export const SESSIONS_DESCRIPTION = "List recent Claude conversations this server has run, newest first, with each conversation's session_id, originating tool, workspace_dir, and topic excerpt. Use it when you lost a session_id or want to continue earlier work: pick the session and resume it with claude_continue (same workspace_dir). The ledger is in-memory and resets when the MCP server restarts.";

const argsSchema = z.object({
  workspace_dir: absolutePathSchema.optional(),
  limit: z.number().int().min(1).max(50).optional()
});

function renderEntry(entry: SessionEntry, index: number): string {
  return [
    `${index + 1}. session_id: ${entry.sessionId}`,
    `   tool: ${entry.tool} | workspace: ${entry.workspaceDir ?? "(none)"} | model: ${entry.model ?? "(default)"} | turns: ${entry.turns}`,
    `   created: ${entry.createdAt} | last_used: ${entry.lastUsedAt}`,
    `   topic: ${entry.excerpt}`
  ].join("\n");
}

export function createSessionsTool(ledger: SessionLedger): ConsultTool {
  return Object.freeze({
    name: "claude_sessions",
    title: "Claude Sessions",
    description: SESSIONS_DESCRIPTION,
    inputSchema: {
      workspace_dir: absolutePathSchema.optional().describe("Optional exact workspace_dir filter."),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum sessions to list, defaulting to 10.")
    },
    execute: async (rawArgs: Record<string, unknown>): Promise<ToolResult> => {
      const args = argsSchema.parse(rawArgs);
      const entries = ledger.list({ workspaceDir: args.workspace_dir, limit: args.limit });
      const text = entries.length === 0
        ? "No conversations recorded since this MCP server started."
        : `Recent Claude conversations (newest first):\n\n${entries.map(renderEntry).join("\n\n")}`;
      return { content: [{ type: "text", text }] };
    }
  });
}
