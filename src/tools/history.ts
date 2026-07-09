import { z } from "zod";
import type { Journal, JournalEntry } from "../journal.js";
import { absolutePathSchema, type ConsultTool } from "./shared-schemas.js";
import type { ToolResult } from "./tool-result.js";

export const HISTORY_DESCRIPTION = "List past Claude consultations recorded in this machine's journal (persists across Codex sessions and server restarts), newest first, with tool, workspace, topic excerpt, cost, and session_id. Use it to recall what Claude was already asked about this project before asking again; resume a listed conversation with claude_continue when the underlying claude session still exists. Only available when the machine owner has set CLAUDE_CONSULT_JOURNAL_DIR.";

const argsSchema = z.object({
  workspace_dir: absolutePathSchema.optional(),
  limit: z.number().int().min(1).max(100).optional()
});

function renderCost(costUsd: number | undefined): string {
  return costUsd === undefined ? "n/a" : String(costUsd);
}

function renderEntry(entry: JournalEntry, index: number): string {
  return [
    `${index + 1}. [${entry.ts}] ${entry.tool} | workspace: ${entry.workspaceDir ?? "(none)"} | model: ${entry.model ?? "(default)"} | cost_usd: ${renderCost(entry.costUsd)}`,
    `   session_id: ${entry.sessionId}`,
    `   topic: ${entry.excerpt}`
  ].join("\n");
}

export function createHistoryTool(journal: Journal): ConsultTool {
  return Object.freeze({
    name: "claude_consult_history",
    title: "Claude Consult History",
    description: HISTORY_DESCRIPTION,
    inputSchema: {
      workspace_dir: absolutePathSchema.optional().describe("Optional exact workspace_dir filter."),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum consultations to list, defaulting to 20.")
    },
    execute: async (rawArgs: Record<string, unknown>): Promise<ToolResult> => {
      const args = argsSchema.parse(rawArgs);
      const entries = await journal.read({ workspaceDir: args.workspace_dir, limit: args.limit });
      const text = entries.length === 0
        ? "The journal is empty."
        : `Past Claude consultations (newest first):\n\n${entries.map(renderEntry).join("\n\n")}`;
      return { content: [{ type: "text", text }] };
    }
  });
}
