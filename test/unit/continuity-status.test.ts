import { describe, expect, it, vi } from "vitest";
import type { Journal, JournalEntry, JournalReadStats } from "../../src/journal.js";
import { CONTINUITY_READ_LIMIT } from "../../src/claude/continuity.js";
import { createContinuityStatusTool } from "../../src/tools/continuity-status.js";

const WORKSPACE = process.platform === "win32" ? "C:\\repo\\project" : "/repo/project";
const OTHER_WORKSPACE = process.platform === "win32" ? "C:\\repo\\other" : "/repo/other";
const SESSION_ID = "123e4567-e89b-12d3-a456-426614174000";

function entry(workspaceDir: string, index: number): JournalEntry {
  return {
    ts: `2026-07-11T00:0${index}:00.000Z`,
    tool: "PRIVATE_TOOL_NAME",
    sessionId: SESSION_ID,
    workspaceDir,
    model: "haiku",
    excerpt: "PRIVATE JOURNAL EXCERPT",
    costUsd: undefined,
    durationMs: undefined
  };
}

function journalWith(result: JournalReadStats | Error): Journal & { appendSpy: ReturnType<typeof vi.fn>; readWithStatsSpy: ReturnType<typeof vi.fn> } {
  const appendSpy = vi.fn(async () => undefined);
  const readWithStatsSpy = vi.fn(async () => {
    if (result instanceof Error) {
      throw result;
    }
    return result;
  });
  return { append: appendSpy, read: async () => [], readWithStats: readWithStatsSpy, appendSpy, readWithStatsSpy };
}

function textOf(result: unknown): string {
  return (result as { readonly content?: readonly { readonly text?: string }[] }).content?.[0]?.text ?? "";
}

describe("claude_continuity_status tool", () => {
  it("reports matching current-month entries without exposing their content", async () => {
    const journal = journalWith({ entries: [entry(WORKSPACE, 1), entry(OTHER_WORKSPACE, 2), entry(WORKSPACE, 3)], skippedLines: 0 });
    const tool = createContinuityStatusTool(journal, true, () => "2026-07");

    const text = textOf(await tool.execute({ workspace_dir: WORKSPACE }));

    expect(JSON.parse(text)).toEqual({ continuity_enabled: true, candidate_count: 3, matching_count: 2, would_inject: true, reason: "matching_entries" });
    expect(Object.keys(JSON.parse(text))).toEqual(["continuity_enabled", "candidate_count", "matching_count", "would_inject", "reason"]);
    expect(text).not.toMatch(/PRIVATE JOURNAL EXCERPT|PRIVATE_TOOL_NAME|123e4567|2026-07-11|recent-consultations/);
    expect(journal.readWithStatsSpy).toHaveBeenCalledWith({ month: "2026-07", limit: CONTINUITY_READ_LIMIT });
    expect(journal.appendSpy).not.toHaveBeenCalled();
    expect(text).not.toContain("[claude-consult]");
  });

  it("reports no workspace match when other candidates exist", async () => {
    const journal = journalWith({ entries: [entry(OTHER_WORKSPACE, 1)], skippedLines: 0 });

    expect(JSON.parse(textOf(await createContinuityStatusTool(journal, true, () => "2026-07").execute({ workspace_dir: WORKSPACE })))).toEqual({
      continuity_enabled: true,
      candidate_count: 1,
      matching_count: 0,
      would_inject: false,
      reason: "no_workspace_match"
    });
  });

  it("reports no candidates when the current month is empty", async () => {
    const journal = journalWith({ entries: [], skippedLines: 0 });

    expect(JSON.parse(textOf(await createContinuityStatusTool(journal, true, () => "2026-07").execute({ workspace_dir: WORKSPACE })))).toEqual({
      continuity_enabled: true,
      candidate_count: 0,
      matching_count: 0,
      would_inject: false,
      reason: "no_candidates"
    });
  });

  it("reports counts while continuity is disabled by owner policy", async () => {
    const journal = journalWith({ entries: [entry(WORKSPACE, 1)], skippedLines: 0 });

    expect(JSON.parse(textOf(await createContinuityStatusTool(journal, false, () => "2026-07").execute({ workspace_dir: WORKSPACE })))).toEqual({
      continuity_enabled: false,
      candidate_count: 1,
      matching_count: 1,
      would_inject: false,
      reason: "continuity_disabled"
    });
  });

  it("fails soft with zero counts when the journal is unreadable", async () => {
    const journal = journalWith(new Error("PRIVATE JOURNAL READ FAILURE"));

    const text = textOf(await createContinuityStatusTool(journal, true, () => "2026-07").execute({ workspace_dir: WORKSPACE }));

    expect(JSON.parse(text)).toEqual({ continuity_enabled: true, candidate_count: 0, matching_count: 0, would_inject: false, reason: "journal_unreadable" });
    expect(text).not.toContain("PRIVATE JOURNAL READ FAILURE");
    expect(journal.appendSpy).not.toHaveBeenCalled();
  });
});
