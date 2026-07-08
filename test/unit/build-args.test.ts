import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { isClaudeConsultError } from "../../src/errors.js";
import { buildClaudeArgs, isFableModel, resolveRunPolicy, type RunSpec } from "../../src/claude/build-args.js";

const SESSION_ID = "123e4567-e89b-12d3-a456-426614174000";

// Absolute-path fixtures must match the host platform because path.isAbsolute
// is host-dependent; CI runs this suite on Windows, macOS, and Linux.
const IS_WINDOWS = process.platform === "win32";
const DIR_A = IS_WINDOWS ? "C:\\proj" : "/proj";
const DIR_B = IS_WINDOWS ? "D:\\lib" : "/lib";
const UNC_FIXTURES = IS_WINDOWS ? ["\\\\host\\share", "\\\\?\\C:\\Windows"] : ["//server/share"];

function baseSpec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    allowedTools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"],
    model: undefined,
    effort: undefined,
    sessionId: undefined,
    appendSystemPrompt: undefined,
    budgetUsd: undefined,
    addDirs: [],
    ...overrides
  };
}

function expectInvalidInput(fn: () => unknown, messagePart: string): void {
  try {
    fn();
    expect.unreachable("expected an INVALID_INPUT error");
  } catch (error) {
    expect(isClaudeConsultError(error)).toBe(true);
    if (isClaudeConsultError(error)) {
      expect(error.code).toBe("INVALID_INPUT");
      expect(`${error.message} ${error.hint}`).toContain(messagePart);
    }
  }
}

describe("buildClaudeArgs", () => {
  it("emits the fixed base flags in exact order", () => {
    const args = buildClaudeArgs(baseSpec());
    expect(args).toEqual(["-p", "--output-format", "json", "--permission-mode", "default", "--allowedTools", "Read,Glob,Grep,WebSearch,WebFetch", "--strict-mcp-config"]);
    expect(Object.isFrozen(args)).toBe(true);
  });

  it("appends every conditional flag in deterministic order", () => {
    const args = buildClaudeArgs(baseSpec({
      model: "sonnet",
      effort: "max",
      sessionId: SESSION_ID,
      appendSystemPrompt: "advisor role text",
      budgetUsd: 1.5,
      addDirs: [DIR_A, DIR_B]
    }));
    expect(args).toEqual([
      "-p", "--output-format", "json", "--permission-mode", "default",
      "--allowedTools", "Read,Glob,Grep,WebSearch,WebFetch", "--strict-mcp-config",
      "--model", "sonnet",
      "--effort", "max",
      "-r", SESSION_ID,
      "--append-system-prompt", "advisor role text",
      "--max-budget-usd", "1.5",
      "--add-dir", DIR_A,
      "--add-dir", DIR_B
    ]);
  });

  it("rejects unknown effort levels", () => {
    expectInvalidInput(() => buildClaudeArgs(baseSpec({ effort: "turbo" })), "effort");
  });

  it("rejects flag-shaped models and malformed session ids", () => {
    expectInvalidInput(() => buildClaudeArgs(baseSpec({ model: "--dangerously-skip-permissions" })), "model");
    expectInvalidInput(() => buildClaudeArgs(baseSpec({ sessionId: "-r; rm -rf /" })), "session");
  });

  it("rejects relative add-dir paths", () => {
    expectInvalidInput(() => buildClaudeArgs(baseSpec({ addDirs: ["src"] })), "absolute");
  });

  it("rejects UNC and device add-dir paths as defense in depth", () => {
    for (const uncPath of UNC_FIXTURES) {
      expectInvalidInput(() => buildClaudeArgs(baseSpec({ addDirs: [uncPath] })), "UNC");
    }
  });

  it("rejects non-positive budgets", () => {
    expectInvalidInput(() => buildClaudeArgs(baseSpec({ budgetUsd: 0 })), "budget");
    expectInvalidInput(() => buildClaudeArgs(baseSpec({ budgetUsd: -1 })), "budget");
  });

  it("rejects forbidden or malformed tool tokens as defense in depth", () => {
    expectInvalidInput(() => buildClaudeArgs(baseSpec({ allowedTools: ["Read", "Write"] })), "Write");
    expectInvalidInput(() => buildClaudeArgs(baseSpec({ allowedTools: ["web-search"] })), "tool");
  });

  it("never emits forbidden flags or write-capable tools", () => {
    const rendered = buildClaudeArgs(baseSpec({ model: "opus", sessionId: SESSION_ID, budgetUsd: 2, addDirs: [DIR_A] })).join(" ");
    for (const forbidden of ["--max-turns", "bypassPermissions", "acceptEdits", "--dangerously-skip-permissions", "Write", "Edit", "Bash"]) {
      expect(rendered).not.toContain(forbidden);
    }
  });
});

describe("resolveRunPolicy", () => {
  it("falls back to the configured default model", () => {
    const config = loadConfig({});
    expect(resolveRunPolicy(config, {}).model).toBe("opus");
  });

  it("propagates follow-cli-default when both are unset", () => {
    const config = loadConfig({ CLAUDE_CONSULT_MODEL: "" });
    expect(resolveRunPolicy(config, {}).model).toBeUndefined();
  });

  it("accepts a requested model inside the whitelist", () => {
    const config = loadConfig({ CLAUDE_CONSULT_MODEL: "sonnet", CLAUDE_CONSULT_ALLOWED_MODELS: "sonnet,haiku" });
    expect(resolveRunPolicy(config, { model: "haiku" }).model).toBe("haiku");
  });

  it("rejects a requested model outside the whitelist and lists the allowed values", () => {
    const config = loadConfig({ CLAUDE_CONSULT_MODEL: "sonnet", CLAUDE_CONSULT_ALLOWED_MODELS: "sonnet,haiku" });
    expectInvalidInput(() => resolveRunPolicy(config, { model: "opus" }), "sonnet, haiku");
  });

  it("rejects malformed requested models even without a whitelist", () => {
    const config = loadConfig({});
    expectInvalidInput(() => resolveRunPolicy(config, { model: "bad model!" }), "model");
  });

  it("uses the env budget cap when the request has none", () => {
    const config = loadConfig({ CLAUDE_CONSULT_MAX_BUDGET_USD: "2" });
    expect(resolveRunPolicy(config, {}).budgetUsd).toBe(2);
  });

  it("accepts a per-call budget at or below the cap and rejects above it", () => {
    const config = loadConfig({ CLAUDE_CONSULT_MAX_BUDGET_USD: "2" });
    expect(resolveRunPolicy(config, { budgetUsd: 1 }).budgetUsd).toBe(1);
    expectInvalidInput(() => resolveRunPolicy(config, { budgetUsd: 3 }), "2");
  });

  it("accepts any positive per-call budget when no cap is set", () => {
    const config = loadConfig({});
    expect(resolveRunPolicy(config, { budgetUsd: 5 }).budgetUsd).toBe(5);
    expectInvalidInput(() => resolveRunPolicy(config, { budgetUsd: 0 }), "budget");
  });

  it("forces max effort for Fable models and leaves others unset", () => {
    const config = loadConfig({});
    expect(resolveRunPolicy(config, { model: "claude-fable-5" }).effort).toBe("max");
    expect(resolveRunPolicy(config, {}).effort).toBeUndefined();
    const fableDefault = loadConfig({ CLAUDE_CONSULT_MODEL: "claude-fable-5" });
    expect(resolveRunPolicy(fableDefault, {}).effort).toBe("max");
  });
});

describe("isFableModel", () => {
  it("detects Fable 5 model ids case-insensitively", () => {
    expect(isFableModel("claude-fable-5")).toBe(true);
    expect(isFableModel("Fable-5")).toBe(true);
    expect(isFableModel("opus")).toBe(false);
    expect(isFableModel(undefined)).toBe(false);
  });
});
