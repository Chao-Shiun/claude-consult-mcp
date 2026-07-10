import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const README = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

describe("README release notes", () => {
  it("documents the v0.8 tool count, gate recall, effort ceiling, doctor trust check, and review gate behavior", () => {
    expect(README).toContain("|  9 tools by default; 10 with gate findings; 11 with journal + gate findings");
    expect(README).toContain("## The tools: nine by default, ten with gate findings, eleven with journal");
    expect(README).toContain("| `claude_sessions` | Recover recent session ids without a Claude run | none (optional `workspace_dir`, `limit`) |");
    expect(README).toContain("| `claude_gate_findings` | Read recent automatic review-gate findings back in-band without a Claude run | none (optional `workspace_dir`, `limit`) |");
    expect(README).toContain("| `claude_consult_history` | Recover past consultation metadata from the opt-in machine journal across Codex sessions and server restarts | none (optional `workspace_dir`, `limit`) |");
    expect(README).toContain("Losing a session? Call `claude_sessions`");
    expect(README).toContain("Use `claude_gate_findings` when the user mentions review-gate findings");
    expect(README).toContain("The tool reads the findings log resolved by the MCP server's environment");
    expect(README).toContain("tools whose table row lists `workspace_dir` require it");
    expect(README).toContain("each entry's `session_id` can be passed to `claude_continue` with that `repo` as `workspace_dir`");
    expect(README).toContain("Every successful result that actually ran Claude ends with a machine-readable footer");
    expect(README).toContain("consult-journal-YYYY-MM.jsonl");
    expect(README).toContain("npx -y claude-consult-mcp setup --install-review-gate");
    expect(README).toContain("npx -y claude-consult-mcp setup --install-review-gate --gate-log <absolute-path>");
    expect(README).toContain("records findings to `CLAUDE_CONSULT_GATE_LOG` or `<CLAUDE_CONSULT_JOURNAL_DIR>/review-gate.log`");
    expect(README).toContain("Each findings entry records the repository as the final header field");
    expect(README).toContain("call `claude_gate_findings` to bring those durable findings back into the MCP conversation");
    expect(README).toContain("use the logged `session_id` with the logged repo as `workspace_dir` in `claude_continue`");
    expect(README).toContain("Oversized diffs exit 0 with stderr `review-gate: diff too large (N bytes), skipped`.");
    expect(README).toContain("Codex does not inject Stop-hook stdout into the next model turn's context.");
    expect(README).toContain("The trust prompt cannot be granted in headless `codex exec`.");
    expect(README).toContain("doctor reports `[warn] review-gate hook installed but not trusted - run codex interactively once and approve the hook, or it will not fire`");
    expect(README).toContain("| `CLAUDE_CONSULT_GATE_LOG` | disabled | Local absolute file path for durable automatic review-gate findings |");
    expect(README).toContain("| `CLAUDE_CONSULT_MAX_EFFORT` | unlimited | Owner-level ceiling for per-call `effort`");
    expect(README).toContain("CLAUDE_CONSULT_GATE_MODEL");
    expect(README).toContain("Claude-calling tools also accept optional `effort`");
    expect(README).toContain("Fable models still default to `--effort max`, but that default is silently clamped to `CLAUDE_CONSULT_MAX_EFFORT`");
    expect(README).toContain("An explicit per-call `effort` above the ceiling is rejected with the allowed levels.");
    expect(README).toContain("Cancelling a tool call in your client also terminates the underlying claude process; nothing keeps running in the background.");
    expect(README).toContain("questions_for_caller");
    expect(README).not.toContain("Every successful result ends with a machine-readable footer");
    expect(README).not.toContain("Every successful result from a Claude-spawning tool ends with a machine-readable footer");
    expect(README).not.toContain("receives Codex's Stop JSON payload");
    expect(README).not.toContain("passive output");
  });
});
