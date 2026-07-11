import { z } from "zod";
import { CONTINUITY_READ_LIMIT, selectContinuityEntries } from "../claude/continuity.js";
import type { Journal } from "../journal.js";
import { absolutePathSchema, type ConsultTool } from "./shared-schemas.js";
import type { ToolResult } from "./tool-result.js";

export const CONTINUITY_STATUS_DESCRIPTION = "Read-only, no Claude call. Reports whether recent-consultation continuity would apply for a workspace: counts of candidate and matching journal entries and whether a fresh consultation there would receive the digest. Call it before consulting to decide whether to pass workspace_dir. It returns only counts and status, never consultation content. Per-call factors (resuming a session, continuity:false) still suppress the digest regardless of this result.";

const argsSchema = z.object({ workspace_dir: absolutePathSchema });

export function createContinuityStatusTool(journal: Journal, continuityEnabled: boolean, currentMonth: () => string = () => new Date().toISOString().slice(0, 7)): ConsultTool {
  return Object.freeze({
    name: "claude_continuity_status",
    title: "Claude Continuity Status",
    description: CONTINUITY_STATUS_DESCRIPTION,
    inputSchema: {
      workspace_dir: absolutePathSchema.describe("Workspace to check for recent-consultation continuity readiness.")
    },
    execute: async (rawArgs: Record<string, unknown>): Promise<ToolResult> => {
      const args = argsSchema.parse(rawArgs);
      try {
        if (journal.readWithStats === undefined) {
          throw new Error("journal stats reader unavailable");
        }
        const stats = await journal.readWithStats({ month: currentMonth(), limit: CONTINUITY_READ_LIMIT });
        const matchingCount = selectContinuityEntries(stats.entries, args.workspace_dir).length;
        const wouldInject = continuityEnabled && matchingCount > 0;
        const reason = !continuityEnabled ? "continuity_disabled" : matchingCount > 0 ? "matching_entries" : stats.entries.length === 0 ? "no_candidates" : "no_workspace_match";
        const structuredContent = { continuity_enabled: continuityEnabled, candidate_count: stats.entries.length, matching_count: matchingCount, would_inject: wouldInject, reason };
        const text = JSON.stringify(structuredContent);
        return { content: [{ type: "text", text }], structuredContent };
      } catch {
        const structuredContent = { continuity_enabled: continuityEnabled, candidate_count: 0, matching_count: 0, would_inject: false, reason: "journal_unreadable" };
        const text = JSON.stringify(structuredContent);
        return { content: [{ type: "text", text }], structuredContent };
      }
    }
  });
}
