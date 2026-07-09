import { describe, expect, it } from "vitest";
import { createSessionLedger } from "../../src/session-ledger.js";
import { createSessionsTool } from "../../src/tools/sessions.js";

const SESSION_A = "123e4567-e89b-12d3-a456-426614174000";
const SESSION_B = "123e4567-e89b-12d3-a456-426614174001";
const SESSION_C = "123e4567-e89b-12d3-a456-426614174002";

function textOf(result: unknown): string {
  return (result as { readonly content?: readonly { readonly text?: string }[] }).content?.[0]?.text ?? "";
}

function ledgerWithClock() {
  const dates = [
    new Date("2026-01-01T00:00:00.000Z"),
    new Date("2026-01-01T00:01:00.000Z"),
    new Date("2026-01-01T00:02:00.000Z")
  ];
  const fallback = dates[dates.length - 1] ?? new Date("2026-01-01T00:02:00.000Z");
  let index = 0;
  return createSessionLedger(50, () => dates[Math.min(index++, dates.length - 1)] ?? fallback);
}

describe("claude_sessions tool", () => {
  it("formats an empty ledger without a Claude footer", async () => {
    const tool = createSessionsTool(createSessionLedger());
    const result = await tool.execute({});
    expect(textOf(result)).toBe("No conversations recorded since this MCP server started.");
    expect(textOf(result)).not.toContain("[claude-consult]");
  });

  it("formats recent sessions newest first", async () => {
    const ledger = ledgerWithClock();
    ledger.record({ sessionId: SESSION_A, tool: "ask_claude", workspaceDir: "C:\\repo-a", model: "haiku", excerpt: "first topic" });
    ledger.record({ sessionId: SESSION_B, tool: "claude_review_diff", workspaceDir: undefined, model: undefined, excerpt: "diff review" });
    const tool = createSessionsTool(ledger);

    expect(textOf(await tool.execute({}))).toBe(`Recent Claude conversations (newest first):

1. session_id: ${SESSION_B}
   tool: claude_review_diff | workspace: (none) | model: (default) | turns: 1
   created: 2026-01-01T00:01:00.000Z | last_used: 2026-01-01T00:01:00.000Z
   topic: diff review

2. session_id: ${SESSION_A}
   tool: ask_claude | workspace: C:\\repo-a | model: haiku | turns: 1
   created: 2026-01-01T00:00:00.000Z | last_used: 2026-01-01T00:00:00.000Z
   topic: first topic`);
  });

  it("honors workspace filtering and limit", async () => {
    const ledger = ledgerWithClock();
    ledger.record({ sessionId: SESSION_A, tool: "ask_claude", workspaceDir: "C:\\repo-a", model: undefined, excerpt: "a" });
    ledger.record({ sessionId: SESSION_B, tool: "ask_claude", workspaceDir: "C:\\repo-b", model: undefined, excerpt: "b" });
    ledger.record({ sessionId: SESSION_C, tool: "ask_claude", workspaceDir: "C:\\repo-a", model: undefined, excerpt: "c" });
    const tool = createSessionsTool(ledger);

    const text = textOf(await tool.execute({ workspace_dir: "C:\\repo-a", limit: 1 }));
    expect(text).toContain(`session_id: ${SESSION_C}`);
    expect(text).not.toContain(SESSION_A);
    expect(text).not.toContain(SESSION_B);
  });
});
