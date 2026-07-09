import { describe, expect, it, vi } from "vitest";
import type { Journal, JournalEntry } from "../../src/journal.js";
import { createHistoryTool } from "../../src/tools/history.js";

const SESSION_A = "123e4567-e89b-12d3-a456-426614174000";
const SESSION_B = "123e4567-e89b-12d3-a456-426614174001";
const WORKSPACE_DIR = process.platform === "win32" ? "C:\\repo-a" : "/repo-a";

function textOf(result: unknown): string {
  return (result as { readonly content?: readonly { readonly text?: string }[] }).content?.[0]?.text ?? "";
}

function journalWith(entries: readonly JournalEntry[]): Journal & { readonly readSpy: ReturnType<typeof vi.fn> } {
  const readSpy = vi.fn(async () => entries);
  return Object.freeze({
    append: async () => undefined,
    read: readSpy,
    readSpy
  });
}

describe("claude_consult_history tool", () => {
  it("formats an empty journal without a Claude footer", async () => {
    const tool = createHistoryTool(journalWith([]));
    const result = await tool.execute({});

    expect(textOf(result)).toBe("The journal is empty.");
    expect(textOf(result)).not.toContain("[claude-consult]");
  });

  it("formats past consultations newest first", async () => {
    const tool = createHistoryTool(journalWith([
      {
        ts: "2026-07-09T03:20:11.000Z",
        tool: "ask_claude",
        sessionId: SESSION_A,
        workspaceDir: WORKSPACE_DIR,
        model: "haiku",
        excerpt: "first topic",
        costUsd: 0.123,
        durationMs: 1200
      },
      {
        ts: "2026-07-09T03:21:11.000Z",
        tool: "review-gate",
        sessionId: SESSION_B,
        workspaceDir: undefined,
        model: undefined,
        excerpt: "automatic post-turn diff review",
        costUsd: undefined,
        durationMs: undefined
      }
    ]));

    expect(textOf(await tool.execute({}))).toBe(`Past Claude consultations (newest first):

1. [2026-07-09T03:20:11.000Z] ask_claude | workspace: ${WORKSPACE_DIR} | model: haiku | cost_usd: 0.123
   session_id: ${SESSION_A}
   topic: first topic

2. [2026-07-09T03:21:11.000Z] review-gate | workspace: (none) | model: (default) | cost_usd: n/a
   session_id: ${SESSION_B}
   topic: automatic post-turn diff review`);
  });

  it("honors workspace filtering and limit", async () => {
    const journal = journalWith([]);
    const tool = createHistoryTool(journal);

    await tool.execute({ workspace_dir: WORKSPACE_DIR, limit: 3 });

    expect(journal.readSpy).toHaveBeenCalledWith({ workspaceDir: WORKSPACE_DIR, limit: 3 });
  });
});
