import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createJournal } from "../../src/journal.js";
import type { Logger } from "../../src/logger.js";

const SESSION_A = "123e4567-e89b-12d3-a456-426614174000";
const SESSION_B = "123e4567-e89b-12d3-a456-426614174001";
const SESSION_C = "123e4567-e89b-12d3-a456-426614174002";

function logger(): { logger: Logger; errors: string[]; debug: string[] } {
  const errors: string[] = [];
  const debug: string[] = [];
  return {
    errors,
    debug,
    logger: {
      error: (message) => errors.push(message),
      info: () => undefined,
      debug: (message) => debug.push(message)
    }
  };
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "ccm-journal-"));
}

describe("createJournal", () => {
  it("appends entries as monthly JSONL and reads them newest first", async () => {
    const dir = await tempDir();
    const logs = logger();
    const journal = createJournal(dir, logs.logger, () => new Date("2026-03-10T00:00:00.000Z"));

    await journal.append({ ts: "2026-03-10T00:00:00.000Z", tool: "ask_claude", sessionId: SESSION_A, workspaceDir: dir, model: "haiku", excerpt: " first\nquestion ", costUsd: 0.1, durationMs: 20 });
    await journal.append({ ts: "2026-03-10T00:01:00.000Z", tool: "claude_continue", sessionId: SESSION_B, workspaceDir: undefined, model: undefined, excerpt: "second", costUsd: undefined, durationMs: undefined });

    const file = path.join(dir, "consult-journal-2026-03.jsonl");
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    const entries = await journal.read();
    expect(entries.map((entry) => entry.sessionId)).toEqual([SESSION_B, SESSION_A]);
    expect(entries[1]?.excerpt).toBe("first question");
    expect(Object.isFrozen(entries[0])).toBe(true);
    expect(Object.isFrozen(entries)).toBe(true);
  });

  it("writes month rollover files and merges months with limit and workspace filtering", async () => {
    const dir = await tempDir();
    const logs = logger();
    const dates = [
      new Date("2026-02-28T23:59:00.000Z"),
      new Date("2026-03-01T00:01:00.000Z"),
      new Date("2026-03-01T00:02:00.000Z")
    ];
    const fallback = dates[0] ?? new Date("2026-02-28T23:59:00.000Z");
    let index = 0;
    const journal = createJournal(dir, logs.logger, () => dates[Math.min(index, dates.length - 1)] ?? fallback);

    await journal.append({ ts: dates[index]?.toISOString() ?? "", tool: "ask_claude", sessionId: SESSION_A, workspaceDir: dir, model: undefined, excerpt: "a", costUsd: undefined, durationMs: undefined });
    index += 1;
    await journal.append({ ts: dates[index]?.toISOString() ?? "", tool: "ask_claude", sessionId: SESSION_B, workspaceDir: `${dir}-other`, model: undefined, excerpt: "b", costUsd: undefined, durationMs: undefined });
    index += 1;
    await journal.append({ ts: dates[index]?.toISOString() ?? "", tool: "ask_claude", sessionId: SESSION_C, workspaceDir: dir, model: undefined, excerpt: "c", costUsd: undefined, durationMs: undefined });

    expect(await readFile(path.join(dir, "consult-journal-2026-02.jsonl"), "utf8")).toContain(SESSION_A);
    expect(await readFile(path.join(dir, "consult-journal-2026-03.jsonl"), "utf8")).toContain(SESSION_C);
    expect((await journal.read({ limit: 2 })).map((entry) => entry.sessionId)).toEqual([SESSION_C, SESSION_B]);
    expect((await journal.read({ workspaceDir: dir })).map((entry) => entry.sessionId)).toEqual([SESSION_C, SESSION_A]);
    expect((await journal.read({ month: "2026-03" })).map((entry) => entry.sessionId)).toEqual([SESSION_C, SESSION_B]);
  });

  it("skips malformed entries normally and rejects them for strict reads", async () => {
    const dir = await tempDir();
    const logs = logger();
    const journal = createJournal(dir, logs.logger, () => new Date("2026-03-10T00:00:00.000Z"));
    await journal.append({ ts: "2026-03-10T00:00:00.000Z", tool: "ask_claude", sessionId: SESSION_A, workspaceDir: dir, model: undefined, excerpt: "a", costUsd: undefined, durationMs: undefined });
    const malformed = { ts: "2026-03-10T00:01:00.000Z", tool: 42, sessionId: SESSION_B, workspaceDir: dir, model: undefined, excerpt: "bad", costUsd: undefined, durationMs: undefined };
    await writeFile(path.join(dir, "consult-journal-2026-03.jsonl"), `not json\n${JSON.stringify(malformed)}\n`, { flag: "a" });

    expect((await journal.read()).map((entry) => entry.sessionId)).toEqual([SESSION_A]);
    expect(logs.debug.join("\n")).toContain("skipping corrupt journal line");
    await expect(journal.read({ strict: true })).rejects.toThrow();
  });

  it("swallows append failures and logs an error", async () => {
    const dir = await tempDir();
    await rm(dir, { recursive: true, force: true });
    await writeFile(dir, "not a directory");
    const logs = logger();
    const journal = createJournal(dir, logs.logger, () => new Date("2026-03-10T00:00:00.000Z"));

    await expect(journal.append({ ts: "2026-03-10T00:00:00.000Z", tool: "ask_claude", sessionId: SESSION_A, workspaceDir: undefined, model: undefined, excerpt: "a", costUsd: undefined, durationMs: undefined })).resolves.toBeUndefined();
    expect(logs.errors.join("\n")).toContain("failed to append consultation journal");
  });

  it("hard-caps excerpts at 120 characters", async () => {
    const dir = await tempDir();
    const logs = logger();
    const journal = createJournal(dir, logs.logger, () => new Date("2026-03-10T00:00:00.000Z"));
    await journal.append({ ts: "2026-03-10T00:00:00.000Z", tool: "ask_claude", sessionId: SESSION_A, workspaceDir: undefined, model: undefined, excerpt: ` ${"x".repeat(80)}\n${"y".repeat(80)} `, costUsd: undefined, durationMs: undefined });

    const [entry] = await journal.read();
    expect(entry?.excerpt).toHaveLength(120);
    expect(entry?.excerpt).not.toMatch(/\s{2,}/);
  });
});
