import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS } from "../../src/constants.js";
import { createGateFindingsTool } from "../../src/tools/gate-findings.js";

const SESSION_A = "123e4567-e89b-12d3-a456-426614174000";
const SESSION_B = "123e4567-e89b-12d3-a456-426614174001";
const SESSION_C = "123e4567-e89b-12d3-a456-426614174002";

async function tempPath(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ccm-gate-findings-"));
  return path.join(await realpath(dir), name);
}

function entry(ts: string, model: string, sessionId: string, repo: string | undefined, body: string): string {
  const repoField = repo === undefined ? "" : ` | repo: ${repo}`;
  return `## ${ts} | model: ${model} | session_id: ${sessionId}${repoField}\n${body}\n\n`;
}

function textOf(result: unknown): string {
  return (result as { readonly content?: readonly { readonly text?: string }[] }).content?.[0]?.text ?? "";
}

function swapAsciiCase(value: string): string {
  return value.replace(/[a-z]/i, (char) => char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase());
}

describe("claude_gate_findings tool", () => {
  it("returns a friendly success when the log file is missing", async () => {
    const tool = createGateFindingsTool(await tempPath("missing.log"));

    const result = await tool.execute({});

    expect(textOf(result)).toBe("No review-gate findings are recorded yet.");
    expect((result as { readonly isError?: boolean }).isError).toBeUndefined();
  });

  it("parses current and legacy headers without splitting markdown headings", async () => {
    const logPath = await tempPath("findings.log");
    const repo = await realpath(await mkdtemp(path.join(os.tmpdir(), "ccm-gate-repo-")));
    await writeFile(logPath, [
      entry("2026-07-09T03:20:11.000Z", "haiku", SESSION_A, undefined, "legacy body"),
      entry("2026-07-10T03:20:11.000Z", "sonnet", SESSION_B, repo, "first line\n## markdown heading\nstill same finding")
    ].join(""), "utf8");
    const tool = createGateFindingsTool(logPath);

    const text = textOf(await tool.execute({}));

    expect(text.indexOf(SESSION_B)).toBeLessThan(text.indexOf(SESSION_A));
    expect(text).toContain(`repo: ${repo}`);
    expect(text).toContain("repo: (unknown)");
    expect(text).toContain("## markdown heading\nstill same finding");
  });

  it("filters by repo, treats legacy entries as held back, and compares win32 paths case-insensitively", async () => {
    const logPath = await tempPath("findings.log");
    const repo = await realpath(await mkdtemp(path.join(os.tmpdir(), "ccm-gate-repo-")));
    const otherRepo = await realpath(await mkdtemp(path.join(os.tmpdir(), "ccm-gate-other-")));
    await writeFile(logPath, [
      entry("2026-07-08T03:20:11.000Z", "haiku", SESSION_A, undefined, "legacy body"),
      entry("2026-07-09T03:20:11.000Z", "haiku", SESSION_B, otherRepo, "other repo"),
      entry("2026-07-10T03:20:11.000Z", "haiku", SESSION_C, repo, "matching repo")
    ].join(""), "utf8");
    const tool = createGateFindingsTool(logPath, { platform: "win32" });

    const text = textOf(await tool.execute({ workspace_dir: swapAsciiCase(repo) }));

    expect(text).toContain(SESSION_C);
    expect(text).not.toContain(SESSION_A);
    expect(text).not.toContain(SESSION_B);
    expect(text).toContain("2 entries were held back by the workspace_dir filter.");
  });

  it("limits newest-first entries and caps oversized entry bodies", async () => {
    const logPath = await tempPath("findings.log");
    await writeFile(logPath, [
      entry("2026-07-08T03:20:11.000Z", "haiku", SESSION_A, undefined, "old"),
      entry("2026-07-09T03:20:11.000Z", "haiku", SESSION_B, undefined, "middle"),
      entry("2026-07-10T03:20:11.000Z", "haiku", SESSION_C, undefined, "x".repeat(LIMITS.gateFindingsEntryBytes + 20))
    ].join(""), "utf8");
    const tool = createGateFindingsTool(logPath);

    const text = textOf(await tool.execute({ limit: 2 }));

    expect(text).toContain(SESSION_C);
    expect(text).toContain(SESSION_B);
    expect(text).not.toContain(SESSION_A);
    expect(text).toContain("(truncated)");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(LIMITS.gateFindingsEntryBytes + 2_000);
  });

  it("reads only the tail of oversized logs and skips malformed content without throwing", async () => {
    const logPath = await tempPath("findings.log");
    const hugePartial = `not a header\n${"x".repeat(LIMITS.gateFindingsTailBytes + 10)}\n`;
    await writeFile(logPath, [
      hugePartial,
      entry("2026-07-10T03:20:11.000Z", "haiku", SESSION_A, undefined, "visible tail finding"),
      "## not a valid review-gate header\nignored\n"
    ].join(""), "utf8");
    const tool = createGateFindingsTool(logPath);

    const text = textOf(await tool.execute({}));

    expect(text).toContain(SESSION_A);
    expect(text).toContain("visible tail finding");
    expect(text).not.toContain("not a header");
  });

  it("returns no readable entries for a malformed log and never adds a Claude footer", async () => {
    const logPath = await tempPath("findings.log");
    await writeFile(logPath, "## bad\nnot parseable\n", "utf8");
    const tool = createGateFindingsTool(logPath);

    const text = textOf(await tool.execute({}));

    expect(text).toBe("No readable review-gate findings were found.");
    expect(text).not.toContain("[claude-consult]");
  });
});
