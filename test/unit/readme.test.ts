import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const README = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

describe("README release notes", () => {
  it("documents the v0.5 tool count, session recall, cancellation, and caller questions", () => {
    expect(README).toContain("|  9 tools, zod-validated, read-only allowlist, injection-hardened argv");
    expect(README).toContain("## The nine tools");
    expect(README).toContain("| `claude_sessions` | Recover recent session ids without a Claude run | none (optional `workspace_dir`, `limit`) |");
    expect(README).toContain("Losing a session? Call `claude_sessions`");
    expect(README).toContain("Cancelling a tool call in your client also terminates the underlying claude process; nothing keeps running in the background.");
    expect(README).toContain("questions_for_caller");
  });
});
