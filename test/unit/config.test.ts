import { describe, expect, it } from "vitest";
import { CAPABILITY_TOOLS } from "../../src/constants.js";
import { isClaudeConsultError } from "../../src/errors.js";
import { loadConfig } from "../../src/config.js";

function expectInvalidInput(fn: () => unknown, messagePart: string): void {
  try {
    fn();
    expect.unreachable("expected loadConfig to throw");
  } catch (error) {
    expect(isClaudeConsultError(error)).toBe(true);
    if (isClaudeConsultError(error)) {
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toContain(messagePart);
    }
  }
}

describe("loadConfig", () => {
  it("applies strongest-capability defaults on an empty environment", () => {
    const config = loadConfig({});
    expect(config.claudeBin).toBeUndefined();
    expect(config.timeoutMs).toBe(600_000);
    expect(config.model).toBe("opus");
    expect(config.allowedModels).toBeUndefined();
    expect(config.capability).toBe("research");
    expect(config.allowedTools).toEqual(CAPABILITY_TOOLS.research);
    expect(config.maxBudgetUsd).toBeUndefined();
    expect(config.maxThinkingTokens).toBeUndefined();
    expect(config.maxConcurrency).toBe(2);
    expect(config.logLevel).toBe("info");
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.allowedTools)).toBe(true);
  });

  it("parses explicit overrides for every variable", () => {
    const config = loadConfig({
      CLAUDE_CONSULT_CLAUDE_BIN: "C:\\tools\\claude.exe",
      CLAUDE_CONSULT_TIMEOUT_MS: "30000",
      CLAUDE_CONSULT_MODEL: "sonnet",
      CLAUDE_CONSULT_ALLOWED_MODELS: "sonnet, haiku",
      CLAUDE_CONSULT_CAPABILITY: "readonly",
      CLAUDE_CONSULT_MAX_BUDGET_USD: "2.5",
      CLAUDE_CONSULT_MAX_THINKING_TOKENS: "10000",
      CLAUDE_CONSULT_MAX_CONCURRENCY: "4",
      CLAUDE_CONSULT_LOG_LEVEL: "debug"
    });
    expect(config.claudeBin).toBe("C:\\tools\\claude.exe");
    expect(config.timeoutMs).toBe(30_000);
    expect(config.model).toBe("sonnet");
    expect(config.allowedModels).toEqual(["sonnet", "haiku"]);
    expect(config.capability).toBe("readonly");
    expect(config.allowedTools).toEqual(CAPABILITY_TOOLS.readonly);
    expect(config.maxBudgetUsd).toBe(2.5);
    expect(config.maxThinkingTokens).toBe(10_000);
    expect(config.maxConcurrency).toBe(4);
    expect(config.logLevel).toBe("debug");
  });

  it("treats an empty model as follow-the-cli-default", () => {
    const config = loadConfig({ CLAUDE_CONSULT_MODEL: "" });
    expect(config.model).toBeUndefined();
  });

  it("lets a fine-grained tool override replace the capability tier list", () => {
    const config = loadConfig({ CLAUDE_CONSULT_ALLOWED_TOOLS: "Read, Grep" });
    expect(config.allowedTools).toEqual(["Read", "Grep"]);
  });

  it("rejects malformed and out-of-range timeouts", () => {
    expectInvalidInput(() => loadConfig({ CLAUDE_CONSULT_TIMEOUT_MS: "abc" }), "CLAUDE_CONSULT_TIMEOUT_MS");
    expectInvalidInput(() => loadConfig({ CLAUDE_CONSULT_TIMEOUT_MS: "4999" }), "CLAUDE_CONSULT_TIMEOUT_MS");
    expectInvalidInput(() => loadConfig({ CLAUDE_CONSULT_TIMEOUT_MS: "1200001" }), "CLAUDE_CONSULT_TIMEOUT_MS");
  });

  it("rejects out-of-range and non-integer concurrency", () => {
    expectInvalidInput(() => loadConfig({ CLAUDE_CONSULT_MAX_CONCURRENCY: "0" }), "CLAUDE_CONSULT_MAX_CONCURRENCY");
    expectInvalidInput(() => loadConfig({ CLAUDE_CONSULT_MAX_CONCURRENCY: "5" }), "CLAUDE_CONSULT_MAX_CONCURRENCY");
    expectInvalidInput(() => loadConfig({ CLAUDE_CONSULT_MAX_CONCURRENCY: "2.5" }), "CLAUDE_CONSULT_MAX_CONCURRENCY");
  });

  it("rejects unknown capability levels including write", () => {
    expectInvalidInput(() => loadConfig({ CLAUDE_CONSULT_CAPABILITY: "write" }), "CLAUDE_CONSULT_CAPABILITY");
    expectInvalidInput(() => loadConfig({ CLAUDE_CONSULT_CAPABILITY: "full" }), "CLAUDE_CONSULT_CAPABILITY");
  });

  it("rejects forbidden tools in the override list", () => {
    expectInvalidInput(() => loadConfig({ CLAUDE_CONSULT_ALLOWED_TOOLS: "Read,Write" }), "Write");
    expectInvalidInput(() => loadConfig({ CLAUDE_CONSULT_ALLOWED_TOOLS: "Bash" }), "Bash");
  });

  it("rejects malformed tool tokens", () => {
    expectInvalidInput(() => loadConfig({ CLAUDE_CONSULT_ALLOWED_TOOLS: "web-search" }), "CLAUDE_CONSULT_ALLOWED_TOOLS");
  });

  it("rejects malformed model whitelist entries", () => {
    expectInvalidInput(() => loadConfig({ CLAUDE_CONSULT_ALLOWED_MODELS: "sonnet,--x" }), "CLAUDE_CONSULT_ALLOWED_MODELS");
  });

  it("rejects a default model that contradicts the whitelist", () => {
    expectInvalidInput(() => loadConfig({ CLAUDE_CONSULT_ALLOWED_MODELS: "sonnet,haiku" }), "CLAUDE_CONSULT_MODEL");
    expect(loadConfig({ CLAUDE_CONSULT_MODEL: "sonnet", CLAUDE_CONSULT_ALLOWED_MODELS: "sonnet,haiku" }).model).toBe("sonnet");
    expect(loadConfig({ CLAUDE_CONSULT_MODEL: "", CLAUDE_CONSULT_ALLOWED_MODELS: "sonnet,haiku" }).model).toBeUndefined();
  });

  it("rejects non-positive or malformed budgets", () => {
    expectInvalidInput(() => loadConfig({ CLAUDE_CONSULT_MAX_BUDGET_USD: "0" }), "CLAUDE_CONSULT_MAX_BUDGET_USD");
    expectInvalidInput(() => loadConfig({ CLAUDE_CONSULT_MAX_BUDGET_USD: "-1" }), "CLAUDE_CONSULT_MAX_BUDGET_USD");
    expectInvalidInput(() => loadConfig({ CLAUDE_CONSULT_MAX_BUDGET_USD: "abc" }), "CLAUDE_CONSULT_MAX_BUDGET_USD");
  });

  it("rejects non-positive or non-integer thinking token caps", () => {
    expectInvalidInput(() => loadConfig({ CLAUDE_CONSULT_MAX_THINKING_TOKENS: "0" }), "CLAUDE_CONSULT_MAX_THINKING_TOKENS");
    expectInvalidInput(() => loadConfig({ CLAUDE_CONSULT_MAX_THINKING_TOKENS: "1.5" }), "CLAUDE_CONSULT_MAX_THINKING_TOKENS");
  });

  it("rejects unknown log levels and invalid default models", () => {
    expectInvalidInput(() => loadConfig({ CLAUDE_CONSULT_LOG_LEVEL: "verbose" }), "CLAUDE_CONSULT_LOG_LEVEL");
    expectInvalidInput(() => loadConfig({ CLAUDE_CONSULT_MODEL: "--dangerously" }), "CLAUDE_CONSULT_MODEL");
  });
});
