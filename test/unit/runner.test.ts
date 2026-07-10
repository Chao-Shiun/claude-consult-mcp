import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { CAPABILITY_TOOLS, SUBAGENT_TOOL_TOKEN } from "../../src/constants.js";
import { isClaudeConsultError, type ErrorCode } from "../../src/errors.js";
import { createLogger } from "../../src/logger.js";
import { createDefaultRunner, createRunner, type RunnerDeps } from "../../src/claude/runner.js";
import type { RawRunOutput, } from "../../src/claude/parse-output.js";
import type { SpawnClaudeRequest } from "../../src/claude/spawn-claude.js";
import { createSessionLedger } from "../../src/session-ledger.js";
import type { Journal, JournalEntry } from "../../src/journal.js";
import { VERDICT_JSON_SCHEMA } from "../../src/tools/second-opinion.js";

const silentLogger = createLogger("silent", { write: () => true });
const SESSION_ID = "123e4567-e89b-12d3-a456-426614174000";
const ABSOLUTE_JOURNAL_DIR = process.platform === "win32" ? "C:\\journal" : "/tmp/journal";

function successRaw(result = "pong"): RawRunOutput {
  return {
    stdout: JSON.stringify({ type: "result", is_error: false, result, session_id: SESSION_ID, total_cost_usd: 0.01, duration_ms: 1200, num_turns: 1 }),
    stderrTail: "",
    exitCode: 0
  };
}

interface Harness {
  spawnRequests: SpawnClaudeRequest[];
  deps: RunnerDeps;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeHarness(env: Record<string, string> = {}, spawnImpl?: RunnerDeps["spawnImpl"]): Harness {
  const spawnRequests: SpawnClaudeRequest[] = [];
  const defaultSpawnImpl: RunnerDeps["spawnImpl"] = async (request) => {
    spawnRequests.push(request);
    return successRaw();
  };
  const recordingSpawnImpl: RunnerDeps["spawnImpl"] = spawnImpl === undefined ? defaultSpawnImpl : async (request, onSpawned) => {
    spawnRequests.push(request);
    return spawnImpl(request, onSpawned);
  };
  return {
    spawnRequests,
    deps: {
      config: loadConfig(env),
      logger: silentLogger,
      locate: async () => "C:\\bin\\claude.cmd",
      spawnImpl: recordingSpawnImpl,
      baseEnv: { PATH: "C:\\bin" },
      defaultCwd: "C:\\Users\\home"
    }
  };
}

async function expectCode(promise: Promise<unknown>, code: ErrorCode): Promise<void> {
  try {
    await promise;
    expect.unreachable(`expected a ${code} error`);
  } catch (error) {
    expect(isClaudeConsultError(error)).toBe(true);
    if (isClaudeConsultError(error)) {
      expect(error.code).toBe(code);
    }
  }
}

describe("createRunner", () => {
  it("runs the full pipeline with policy defaults applied", async () => {
    const harness = makeHarness();
    const runner = createRunner(harness.deps);
    const envelope = await runner.run({ prompt: "analyze this" });
    expect(envelope.result).toBe("pong");
    expect(envelope.sessionId).toBe(SESSION_ID);
    const request = harness.spawnRequests[0];
    expect(request?.binPath).toBe("C:\\bin\\claude.cmd");
    expect(request?.prompt).toBe("analyze this");
    expect(request?.cwd).toBe("C:\\Users\\home");
    expect(request?.timeoutMs).toBe(600_000);
    expect(request?.args).toContain("--model");
    expect(request?.args).toContain("opus");
    expect(request?.env["MAX_THINKING_TOKENS"]).toBeUndefined();
  });

  it("honors an explicit cwd and session id", async () => {
    const harness = makeHarness();
    const runner = createRunner(harness.deps);
    await runner.run({ prompt: "follow up", cwd: "C:\\proj", sessionId: SESSION_ID });
    const request = harness.spawnRequests[0];
    expect(request?.cwd).toBe("C:\\proj");
    const args = request?.args ?? [];
    expect(args[args.indexOf("-r") + 1]).toBe(SESSION_ID);
  });

  it("passes a json schema into the child argv", async () => {
    const harness = makeHarness();
    const runner = createRunner(harness.deps);
    await runner.run({ prompt: "structured", jsonSchema: VERDICT_JSON_SCHEMA });
    const args = harness.spawnRequests[0]?.args ?? [];
    expect(args[args.indexOf("--json-schema") + 1]).toBe(VERDICT_JSON_SCHEMA);
  });

  it("rejects deep analysis unless the machine enables deep-research", async () => {
    const harness = makeHarness();
    const runner = createRunner(harness.deps);
    await expectCode(runner.run({ prompt: "investigate broadly", depth: "deep" }), "INVALID_INPUT");
    expect(harness.spawnRequests).toHaveLength(0);
  });

  it("passes the deep-research tool list and guidance when depth is deep", async () => {
    const harness = makeHarness({ CLAUDE_CONSULT_CAPABILITY: "deep-research" });
    const runner = createRunner(harness.deps);
    await runner.run({ prompt: "investigate broadly", depth: "deep" });
    const request = harness.spawnRequests[0];
    const args = request?.args ?? [];
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(CAPABILITY_TOOLS["deep-research"].join(","));
    expect(args[args.indexOf("--allowedTools") + 1]).toContain(SUBAGENT_TOOL_TOKEN);
    expect(request?.prompt).toContain("You may delegate read-only exploration to sub-agents to cover large scopes, then synthesize their findings yourself.");
  });

  it("keeps standard runs on the research tool list even when the machine enables deep-research", async () => {
    const harness = makeHarness({ CLAUDE_CONSULT_CAPABILITY: "deep-research" });
    const runner = createRunner(harness.deps);
    await runner.run({ prompt: "standard review", depth: "standard" });
    const request = harness.spawnRequests[0];
    const args = request?.args ?? [];
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(CAPABILITY_TOOLS.research.join(","));
    expect(args[args.indexOf("--allowedTools") + 1]).not.toContain(SUBAGENT_TOOL_TOKEN);
    expect(request?.prompt).not.toContain("You may delegate read-only exploration");
  });

  it("injects MAX_THINKING_TOKENS only when the cap is configured", async () => {
    const harness = makeHarness({ CLAUDE_CONSULT_MAX_THINKING_TOKENS: "9000" });
    const runner = createRunner(harness.deps);
    await runner.run({ prompt: "think less" });
    expect(harness.spawnRequests[0]?.env["MAX_THINKING_TOKENS"]).toBe("9000");
    expect(harness.deps.baseEnv["MAX_THINKING_TOKENS"]).toBeUndefined();
  });

  it("rejects empty and oversized prompts before spawning", async () => {
    const harness = makeHarness();
    const runner = createRunner(harness.deps);
    await expectCode(runner.run({ prompt: "   " }), "INVALID_INPUT");
    await expectCode(runner.run({ prompt: "x".repeat(400_001) }), "INVALID_INPUT");
    expect(harness.spawnRequests).toHaveLength(0);
  });

  it("rejects a pre-cancelled request before locating or spawning claude", async () => {
    const controller = new AbortController();
    controller.abort();
    let locateCalls = 0;
    const harness = makeHarness();
    const runner = createRunner({
      ...harness.deps,
      locate: async () => {
        locateCalls += 1;
        return "C:\\bin\\claude.cmd";
      }
    });
    await expectCode(runner.run({ prompt: "cancelled", signal: controller.signal }), "REQUEST_CANCELLED");
    expect(locateCalls).toBe(0);
    expect(harness.spawnRequests).toHaveLength(0);
  });

  it("kills the child once on mid-run abort and reports REQUEST_CANCELLED", async () => {
    const controller = new AbortController();
    let kills = 0;
    const harness = makeHarness({}, (_request, onSpawned) =>
      new Promise<RawRunOutput>((resolve) => {
        let unregister: (() => void) | undefined;
        unregister = onSpawned(() => {
          kills += 1;
          unregister?.();
          resolve({ stdout: "", stderrTail: "killed after abort", exitCode: 1 });
        });
      }));
    const runner = createRunner(harness.deps);
    const pending = runner.run({ prompt: "long analysis", signal: controller.signal });
    await flush();
    controller.abort();
    await expectCode(pending, "REQUEST_CANCELLED");
    expect(kills).toBe(1);
  });

  it("removes the abort listener after a normal completion", async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    let kills = 0;
    const harness = makeHarness({}, (_request, onSpawned) => {
      onSpawned(() => {
        kills += 1;
      });
      return Promise.resolve(successRaw());
    });
    const runner = createRunner(harness.deps);
    await runner.run({ prompt: "quick analysis", signal: controller.signal });
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    controller.abort();
    expect(kills).toBe(0);
  });

  it("releases the semaphore permit after a queued cancelled run", async () => {
    let finishFirst: (() => void) | undefined;
    const controller = new AbortController();
    const harness = makeHarness({ CLAUDE_CONSULT_MAX_CONCURRENCY: "1" }, (request) => {
      if (request.prompt === "first") {
        return new Promise((resolve) => {
          finishFirst = () => resolve(successRaw("first"));
        });
      }
      return Promise.resolve(successRaw(request.prompt));
    });
    const runner = createRunner(harness.deps);
    const first = runner.run({ prompt: "first" });
    await flush();
    const second = runner.run({ prompt: "second", signal: controller.signal });
    controller.abort();
    finishFirst?.();
    await first;
    await expectCode(second, "REQUEST_CANCELLED");
    await expect(runner.run({ prompt: "third" })).resolves.toMatchObject({ result: "third" });
    expect(harness.spawnRequests.map((request) => request.prompt)).toEqual(["first", "third"]);
  });

  it("rejects models outside the whitelist before spawning", async () => {
    const harness = makeHarness({ CLAUDE_CONSULT_MODEL: "sonnet", CLAUDE_CONSULT_ALLOWED_MODELS: "sonnet,haiku" });
    const runner = createRunner(harness.deps);
    await expectCode(runner.run({ prompt: "hi", model: "opus" }), "INVALID_INPUT");
    expect(harness.spawnRequests).toHaveLength(0);
  });

  it("serializes spawns beyond the concurrency permit count", async () => {
    let releaseFirst: (() => void) | undefined;
    const harness = makeHarness({ CLAUDE_CONSULT_MAX_CONCURRENCY: "1" }, (request) => {
      if (releaseFirst === undefined) {
        return new Promise((resolve) => {
          releaseFirst = () => resolve(successRaw());
        });
      }
      return Promise.resolve(successRaw());
    });
    const runner = createRunner(harness.deps);
    const first = runner.run({ prompt: "first" });
    const second = runner.run({ prompt: "second" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.spawnRequests).toHaveLength(1);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(harness.spawnRequests).toHaveLength(2);
  });

  it("kills in-flight children and forgets settled ones", async () => {
    const kills: string[] = [];
    let finish: (() => void) | undefined;
    const harness = makeHarness({}, (request, onSpawned) => {
      const unregister = onSpawned(() => kills.push(request.prompt));
      return new Promise((resolve) => {
        finish = () => {
          unregister();
          resolve(successRaw());
        };
      });
    });
    const runner = createRunner(harness.deps);
    const pending = runner.run({ prompt: "long analysis" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runner.killInFlight()).toBe(1);
    expect(kills).toEqual(["long analysis"]);
    finish?.();
    await pending;
    expect(runner.killInFlight()).toBe(0);
    expect(kills).toEqual(["long analysis"]);
  });

  it("propagates parser classification such as CLAUDE_NOT_AUTHENTICATED", async () => {
    const authRaw: RawRunOutput = {
      stdout: `{"type":"result","is_error":true,"api_error_status":401,"result":"Failed to authenticate.","session_id":"${SESSION_ID}"}`,
      stderrTail: "",
      exitCode: 1
    };
    const harness = makeHarness({}, async () => authRaw);
    const runner = createRunner(harness.deps);
    await expectCode(runner.run({ prompt: "hi" }), "CLAUDE_NOT_AUTHENTICATED");
  });

  it("records successful conversations in the session ledger when origin is present", async () => {
    const ledger = createSessionLedger(50, () => new Date("2026-01-01T00:00:00.000Z"));
    const harness = makeHarness();
    const runner = createRunner({ ...harness.deps, ledger });
    await runner.run({ prompt: "hi", cwd: "C:\\repo", model: "haiku", origin: { tool: "ask_claude", excerpt: "What changed?" } });

    expect(ledger.list()).toEqual([{
      sessionId: SESSION_ID,
      tool: "ask_claude",
      workspaceDir: "C:\\repo",
      model: "haiku",
      excerpt: "What changed?",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      turns: 1
    }]);
  });

  it("records successful conversations in the journal when configured", async () => {
    const entries: JournalEntry[] = [];
    const journal: Journal = {
      append: async (entry) => {
        entries.push(entry);
      },
      read: async () => []
    };
    const harness = makeHarness();
    const runner = createRunner({ ...harness.deps, journal });
    await runner.run({ prompt: "hi", cwd: "C:\\repo", model: "haiku", origin: { tool: "ask_claude", excerpt: "What changed?" } });
    await flush();

    expect(entries).toEqual([{
      ts: expect.any(String) as string,
      sessionId: SESSION_ID,
      tool: "ask_claude",
      workspaceDir: "C:\\repo",
      model: "haiku",
      excerpt: "What changed?",
      costUsd: 0.01,
      durationMs: 1200
    }]);
  });

  it("uses the first non-empty result line for the origin excerpt when requested", async () => {
    const ledger = createSessionLedger();
    const entries: JournalEntry[] = [];
    const journal: Journal = {
      append: async (entry) => {
        entries.push(entry);
      },
      read: async () => []
    };
    const harness = makeHarness({}, async () => successRaw("\n  first finding  \nsecond finding"));
    const runner = createRunner({ ...harness.deps, ledger, journal });

    await runner.run({ prompt: "hi", origin: { tool: "review-gate", excerpt: "static excerpt", excerptFromResult: true } });
    await flush();

    expect(ledger.list()[0]?.excerpt).toBe("first finding");
    expect(entries[0]?.excerpt).toBe("  first finding  ");
  });

  it("falls back to the static origin excerpt when the result is whitespace", async () => {
    const ledger = createSessionLedger();
    const harness = makeHarness({}, async () => successRaw(" \n\t "));
    const runner = createRunner({ ...harness.deps, ledger });

    await runner.run({ prompt: "hi", origin: { tool: "review-gate", excerpt: "static excerpt", excerptFromResult: true } });

    expect(ledger.list()[0]?.excerpt).toBe("static excerpt");
  });

  it("skips journal writes when unset and when origin is absent", async () => {
    const entries: JournalEntry[] = [];
    const journal: Journal = {
      append: async (entry) => {
        entries.push(entry);
      },
      read: async () => []
    };
    const harness = makeHarness();
    const runner = createRunner({ ...harness.deps, journal });
    await runner.run({ prompt: "doctor probe" });
    await flush();

    expect(entries).toHaveLength(0);
    expect(createRunner(harness.deps).journal).toBeUndefined();
  });

  it("does not fail the run when a journal stub rejects", async () => {
    const journal: Journal = {
      append: async () => {
        throw new Error("disk full");
      },
      read: async () => []
    };
    const harness = makeHarness();
    const runner = createRunner({ ...harness.deps, journal });

    await expect(runner.run({ prompt: "hi", origin: { tool: "ask_claude", excerpt: "hi" } })).resolves.toMatchObject({ sessionId: SESSION_ID });
    await flush();
  });

  it("creates a default journal only when the journal directory is configured", () => {
    expect(createDefaultRunner(loadConfig({}), silentLogger).journal).toBeUndefined();
    expect(createDefaultRunner(loadConfig({ CLAUDE_CONSULT_JOURNAL_DIR: ABSOLUTE_JOURNAL_DIR }), silentLogger).journal).toBeDefined();
  });

  it("bumps an existing ledger session on resume and skips runs without origin", async () => {
    let ticks = 0;
    const dates = [new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:01:00.000Z")];
    const fallback = dates[dates.length - 1] ?? new Date("2026-01-01T00:01:00.000Z");
    const ledger = createSessionLedger(50, () => dates[Math.min(ticks++, dates.length - 1)] ?? fallback);
    const harness = makeHarness();
    const runner = createRunner({ ...harness.deps, ledger });
    await runner.run({ prompt: "first", origin: { tool: "ask_claude", excerpt: "first topic" } });
    await runner.run({ prompt: "second", sessionId: SESSION_ID, origin: { tool: "claude_continue", excerpt: "second topic" } });
    await runner.run({ prompt: "doctor probe" });

    const [entry] = ledger.list();
    expect(entry).toMatchObject({
      sessionId: SESSION_ID,
      tool: "ask_claude",
      excerpt: "first topic",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:01:00.000Z",
      turns: 2
    });
    expect(ledger.list()).toHaveLength(1);
  });
});
