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
    expect(README).toContain("npx -y claude-consult-mcp setup --install-review-gate --gate-log <absolute-path>");
    expect(README).toContain("records findings to `CLAUDE_CONSULT_GATE_LOG` or `<CLAUDE_CONSULT_JOURNAL_DIR>/review-gate.log`");
    expect(README).toContain("Oversized diffs exit 0 with stderr `review-gate: diff too large (N bytes), skipped`.");
    expect(README).toContain("Codex does not inject Stop-hook stdout into the next model turn's context.");
    expect(README).toContain("The trust prompt cannot be granted in headless `codex exec`.");
    expect(README).toContain("| `CLAUDE_CONSULT_GATE_LOG` | disabled | Local absolute file path for durable automatic review-gate findings |");
    expect(README).toContain("CLAUDE_CONSULT_GATE_MODEL");
    expect(README).toContain("Cancelling a tool call in your client also terminates the underlying claude process; nothing keeps running in the background.");
    expect(README).toContain("questions_for_caller");
    expect(README).not.toContain("receives Codex's Stop JSON payload");
    expect(README).not.toContain("passive output");
  });
});
