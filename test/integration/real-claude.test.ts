import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { isClaudeConsultError } from "../../src/errors.js";
import { createLogger } from "../../src/logger.js";
import { createDefaultRunner } from "../../src/claude/runner.js";

const E2E_ENABLED = process.env["CLAUDE_CONSULT_E2E"] === "1";
const silentLogger = createLogger("silent", { write: () => true });

// Requires an authenticated claude CLI on this machine; costs real tokens.
describe.skipIf(!E2E_ENABLED)("real claude round-trip (CLAUDE_CONSULT_E2E=1)", () => {
  it("asks, then continues the same session with context retained", async () => {
    const config = loadConfig({ ...process.env, CLAUDE_CONSULT_MODEL: process.env["CLAUDE_CONSULT_MODEL"] ?? "haiku" });
    const runner = createDefaultRunner(config, silentLogger);
    const first = await runner.run({ prompt: "Remember the code word BANANA. Reply with exactly: pong" });
    expect(first.result.toLowerCase()).toContain("pong");
    expect(first.sessionId).toMatch(/^[0-9a-fA-F-]{36}$/);
    const second = await runner.run({ prompt: "What was the code word? Reply with only that word.", sessionId: first.sessionId });
    expect(second.result.toUpperCase()).toContain("BANANA");
  }, 600_000);

  it("terminates a run that exceeds a tiny timeout", async () => {
    const config = loadConfig({ ...process.env, CLAUDE_CONSULT_TIMEOUT_MS: "5000" });
    const runner = createDefaultRunner(config, silentLogger);
    try {
      await runner.run({ prompt: "Write a very long and detailed essay about distributed systems." });
      expect.unreachable("expected a timeout");
    } catch (error) {
      expect(isClaudeConsultError(error)).toBe(true);
      if (isClaudeConsultError(error)) {
        expect(error.code).toBe("CLAUDE_TIMEOUT");
      }
    }
  }, 60_000);
});
