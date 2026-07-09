import { describe, expect, it } from "vitest";
import { CAPABILITIES, CAPABILITY_TOOLS, CHILD_ENV_MAX_THINKING_TOKENS, CODEX_SERVER_ID, DEFAULTS, EFFORT_LEVELS, ENV, FABLE_MODEL_MARKER, FOOTER_PREFIX, FORBIDDEN_TOOLS, LIMITS, LOG_LEVELS, PATTERNS, SERVER_NAME, SUBAGENT_TOOL_TOKEN, VERIFIED_CLAUDE_VERSION, VERSION } from "../../src/constants.js";

describe("constants", () => {
  it("exposes package identity values", () => {
    expect(VERSION).toBe("0.6.0");
    expect(SERVER_NAME).toBe("claude-consult-mcp");
    expect(CODEX_SERVER_ID).toBe("claude-consult");
    expect(FOOTER_PREFIX).toBe("[claude-consult]");
    expect(CHILD_ENV_MAX_THINKING_TOKENS).toBe("MAX_THINKING_TOKENS");
    expect(FABLE_MODEL_MARKER).toBe("fable");
    expect(VERIFIED_CLAUDE_VERSION).toBe("2.1.163");
  });

  it("defines the exact environment variable names", () => {
    expect(ENV).toEqual({
      claudeBin: "CLAUDE_CONSULT_CLAUDE_BIN",
      timeoutMs: "CLAUDE_CONSULT_TIMEOUT_MS",
      model: "CLAUDE_CONSULT_MODEL",
      allowedModels: "CLAUDE_CONSULT_ALLOWED_MODELS",
      capability: "CLAUDE_CONSULT_CAPABILITY",
      allowedTools: "CLAUDE_CONSULT_ALLOWED_TOOLS",
      maxBudgetUsd: "CLAUDE_CONSULT_MAX_BUDGET_USD",
      maxThinkingTokens: "CLAUDE_CONSULT_MAX_THINKING_TOKENS",
      journalDir: "CLAUDE_CONSULT_JOURNAL_DIR",
      gateModel: "CLAUDE_CONSULT_GATE_MODEL",
      maxConcurrency: "CLAUDE_CONSULT_MAX_CONCURRENCY",
      logLevel: "CLAUDE_CONSULT_LOG_LEVEL",
      e2e: "CLAUDE_CONSULT_E2E"
    });
  });

  it("defines strongest-capability defaults confirmed by the user", () => {
    expect(DEFAULTS.timeoutMs).toBe(600_000);
    expect(DEFAULTS.model).toBe("opus");
    expect(DEFAULTS.capability).toBe("research");
    expect(DEFAULTS.maxConcurrency).toBe(2);
    expect(DEFAULTS.logLevel).toBe("info");
  });

  it("defines numeric bounds and size limits", () => {
    expect(LIMITS.timeoutMsMin).toBe(5_000);
    expect(LIMITS.timeoutMsMax).toBe(1_200_000);
    expect(LIMITS.concurrencyMin).toBe(1);
    expect(LIMITS.concurrencyMax).toBe(4);
    expect(LIMITS.promptMaxBytes).toBe(400_000);
    expect(LIMITS.stdoutMaxBytes).toBe(10 * 1024 * 1024);
    expect(LIMITS.stderrTailBytes).toBe(64 * 1024);
    expect(LIMITS.stderrSnippetChars).toBe(2_000);
    expect(LIMITS.stdoutSampleChars).toBe(500);
    expect(LIMITS.pathsMax).toBe(32);
  });

  it("defines exactly three capability tiers without any write-capable tool", () => {
    expect(CAPABILITIES).toEqual(["readonly", "research", "deep-research"]);
    expect(SUBAGENT_TOOL_TOKEN).toBe("Agent");
    expect(CAPABILITY_TOOLS.readonly).toEqual(["Read", "Glob", "Grep"]);
    expect(CAPABILITY_TOOLS.research).toEqual(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);
    expect(CAPABILITY_TOOLS["deep-research"]).toEqual(["Read", "Glob", "Grep", "WebSearch", "WebFetch", SUBAGENT_TOOL_TOKEN]);
    for (const tier of CAPABILITIES) {
      for (const forbidden of FORBIDDEN_TOOLS) {
        expect(CAPABILITY_TOOLS[tier]).not.toContain(forbidden);
      }
    }
  });

  it("forbids every write-capable tool by name", () => {
    expect(FORBIDDEN_TOOLS).toEqual(["Write", "Edit", "NotebookEdit", "Bash"]);
  });

  it("defines log levels from silent to debug", () => {
    expect(LOG_LEVELS).toEqual(["silent", "error", "info", "debug"]);
  });

  it("defines effort levels with max as the ceiling", () => {
    expect(EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(Object.isFrozen(EFFORT_LEVELS)).toBe(true);
  });

  it("validates session ids as UUIDs", () => {
    expect(PATTERNS.sessionId.test("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    expect(PATTERNS.sessionId.test("ABCDEF01-2345-6789-abcd-ef0123456789")).toBe(true);
    expect(PATTERNS.sessionId.test("not-a-uuid")).toBe(false);
    expect(PATTERNS.sessionId.test("-r; rm -rf /")).toBe(false);
    expect(PATTERNS.sessionId.test("")).toBe(false);
  });

  it("validates model names against the safe charset", () => {
    expect(PATTERNS.model.test("opus")).toBe(true);
    expect(PATTERNS.model.test("claude-opus-4-8")).toBe(true);
    expect(PATTERNS.model.test("claude-fable-5")).toBe(true);
    expect(PATTERNS.model.test("--dangerously-skip-permissions")).toBe(false);
    expect(PATTERNS.model.test("a model")).toBe(false);
    expect(PATTERNS.model.test("")).toBe(false);
    expect(PATTERNS.model.test(`m${"x".repeat(64)}`)).toBe(false);
  });

  it("flags UNC and device paths so they can be rejected", () => {
    expect(PATTERNS.uncOrDevice.test("\\\\attacker\\share\\x")).toBe(true);
    expect(PATTERNS.uncOrDevice.test("\\\\?\\C:\\Windows")).toBe(true);
    expect(PATTERNS.uncOrDevice.test("//server/share")).toBe(true);
    expect(PATTERNS.uncOrDevice.test("C:\\Users\\me")).toBe(false);
    expect(PATTERNS.uncOrDevice.test("/home/me")).toBe(false);
  });

  it("validates tool tokens as identifier-like names", () => {
    expect(PATTERNS.toolToken.test("Read")).toBe(true);
    expect(PATTERNS.toolToken.test("WebSearch")).toBe(true);
    expect(PATTERNS.toolToken.test("--Read")).toBe(false);
    expect(PATTERNS.toolToken.test("web-search")).toBe(false);
    expect(PATTERNS.toolToken.test("1Tool")).toBe(false);
  });

  it("freezes every exported structure", () => {
    for (const value of [ENV, DEFAULTS, LIMITS, CAPABILITIES, CAPABILITY_TOOLS, CAPABILITY_TOOLS.readonly, CAPABILITY_TOOLS.research, CAPABILITY_TOOLS["deep-research"], FORBIDDEN_TOOLS, LOG_LEVELS, PATTERNS]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it("leaves RegExp instances unfrozen so zod regex checks can write lastIndex", () => {
    expect(Object.isFrozen(PATTERNS.sessionId)).toBe(false);
    expect(Object.isFrozen(PATTERNS.model)).toBe(false);
    expect(Object.isFrozen(PATTERNS.toolToken)).toBe(false);
  });
});
