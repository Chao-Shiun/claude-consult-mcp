import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const README = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

describe("README release notes", () => {
  it("documents the v0.6 tool count, journal, review gate, cancellation, and caller questions", () => {
    expect(README).toContain("|  9 tools by default; 10 with the opt-in consultation journal");
    expect(README).toContain("## The tools: nine by default, ten with journal");
    expect(README).toContain("| `claude_sessions` | Recover recent session ids without a Claude run | none (optional `workspace_dir`, `limit`) |");
    expect(README).toContain("| `claude_consult_history` | Recover past consultation metadata from the opt-in machine journal across Codex sessions and server restarts | none (optional `workspace_dir`, `limit`) |");
    expect(README).toContain("Losing a session? Call `claude_sessions`");
    expect(README).toContain("consult-journal-YYYY-MM.jsonl");
    expect(README).toContain("npx -y claude-consult-mcp setup --install-review-gate");
    expect(README).toContain("CLAUDE_CONSULT_GATE_MODEL");
    expect(README).toContain("Cancelling a tool call in your client also terminates the underlying claude process; nothing keeps running in the background.");
    expect(README).toContain("questions_for_caller");
  });
});
