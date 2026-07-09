import { describe, expect, it } from "vitest";
import { createSessionLedger } from "../../src/session-ledger.js";

const SESSION_A = "123e4567-e89b-12d3-a456-426614174000";
const SESSION_B = "123e4567-e89b-12d3-a456-426614174001";
const SESSION_C = "123e4567-e89b-12d3-a456-426614174002";

function clock(): { now: () => Date; iso: (index: number) => string } {
  const dates = [
    new Date("2026-01-01T00:00:00.000Z"),
    new Date("2026-01-01T00:01:00.000Z"),
    new Date("2026-01-01T00:02:00.000Z"),
    new Date("2026-01-01T00:03:00.000Z")
  ];
  const fallback = dates[dates.length - 1] ?? new Date("2026-01-01T00:03:00.000Z");
  let index = 0;
  return {
    now: () => dates[Math.min(index++, dates.length - 1)] ?? fallback,
    iso: (entryIndex: number) => (dates[entryIndex] ?? fallback).toISOString()
  };
}

describe("createSessionLedger", () => {
  it("upserts by session id, bumps turns, and keeps original topic metadata", () => {
    const times = clock();
    const ledger = createSessionLedger(50, times.now);
    ledger.record({ sessionId: SESSION_A, tool: "ask_claude", workspaceDir: "C:\\repo", model: "haiku", excerpt: "first question" });
    ledger.record({ sessionId: SESSION_A, tool: "claude_continue", workspaceDir: "C:\\other", model: "opus", excerpt: "second turn" });

    const [entry] = ledger.list();
    expect(entry).toMatchObject({
      sessionId: SESSION_A,
      tool: "ask_claude",
      workspaceDir: "C:\\repo",
      model: "haiku",
      excerpt: "first question",
      createdAt: times.iso(0),
      lastUsedAt: times.iso(1),
      turns: 2
    });
    expect(Object.isFrozen(entry)).toBe(true);
  });

  it("evicts the oldest last-used session when over capacity", () => {
    const times = clock();
    const ledger = createSessionLedger(2, times.now);
    ledger.record({ sessionId: SESSION_A, tool: "ask_claude", workspaceDir: "C:\\repo", model: undefined, excerpt: "a" });
    ledger.record({ sessionId: SESSION_B, tool: "ask_claude", workspaceDir: "C:\\repo", model: undefined, excerpt: "b" });
    ledger.record({ sessionId: SESSION_A, tool: "claude_continue", workspaceDir: "C:\\repo", model: undefined, excerpt: "a again" });
    ledger.record({ sessionId: SESSION_C, tool: "ask_claude", workspaceDir: "C:\\repo", model: undefined, excerpt: "c" });

    expect(ledger.list().map((entry) => entry.sessionId)).toEqual([SESSION_C, SESSION_A]);
  });

  it("normalizes whitespace and hard-caps excerpts at 120 characters", () => {
    const ledger = createSessionLedger();
    ledger.record({ sessionId: SESSION_A, tool: "ask_claude", workspaceDir: undefined, model: undefined, excerpt: `  ${"x".repeat(80)}\n\t${"y".repeat(80)}  ` });

    const [entry] = ledger.list();
    expect(entry?.excerpt).toHaveLength(120);
    expect(entry?.excerpt).not.toMatch(/\s{2,}/);
  });

  it("lists newest first with workspace filtering and bounded limits", () => {
    const times = clock();
    const ledger = createSessionLedger(50, times.now);
    ledger.record({ sessionId: SESSION_A, tool: "ask_claude", workspaceDir: "C:\\repo-a", model: undefined, excerpt: "a" });
    ledger.record({ sessionId: SESSION_B, tool: "ask_claude", workspaceDir: "C:\\repo-b", model: undefined, excerpt: "b" });
    ledger.record({ sessionId: SESSION_C, tool: "ask_claude", workspaceDir: "C:\\repo-a", model: undefined, excerpt: "c" });

    expect(ledger.list().map((entry) => entry.sessionId)).toEqual([SESSION_C, SESSION_B, SESSION_A]);
    expect(ledger.list({ workspaceDir: "C:\\repo-a" }).map((entry) => entry.sessionId)).toEqual([SESSION_C, SESSION_A]);
    expect(ledger.list({ limit: 1 }).map((entry) => entry.sessionId)).toEqual([SESSION_C]);
    expect(ledger.list({ limit: 99 })).toHaveLength(3);
    expect(Object.isFrozen(ledger.list())).toBe(true);
  });
});
