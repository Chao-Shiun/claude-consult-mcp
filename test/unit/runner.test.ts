import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { CAPABILITY_TOOLS, LIMITS, SUBAGENT_TOOL_TOKEN } from "../../src/constants.js";
import { isClaudeConsultError, type ErrorCode } from "../../src/errors.js";
import { createLogger } from "../../src/logger.js";
import { createDefaultRunner, createRunner, type RunnerDeps, type RunnerRequest } from "../../src/claude/runner.js";
import type { RawRunOutput, } from "../../src/claude/parse-output.js";
import type { SpawnClaudeRequest } from "../../src/claude/spawn-claude.js";
import { createSessionLedger } from "../../src/session-ledger.js";
import type { Journal, JournalEntry } from "../../src/journal.js";
import { VERDICT_JSON_SCHEMA } from "../../src/tools/second-opinion.js";

const silentLogger = createLogger("silent", { write: () => true });
const SESSION_ID = "123e4567-e89b-12d3-a456-426614174000";
const ABSOLUTE_JOURNAL_DIR = process.platform === "win32" ? "C:\\journal" : "/tmp/journal";
const WORKSPACE = process.platform === "win32" ? "C:\\repo\\project" : "/tmp/repo/project";
const OTHER_WORKSPACE = process.platform === "win32" ? "C:\\repo\\other" : "/tmp/repo/other";

const effortArgCases: Array<{
  readonly name: string;
  readonly env: Record<string, string>;
  readonly request: Pick<RunnerRequest, "model" | "effort">;
  readonly expectedEffort: string | undefined;
}> = [
  {
    name: "explicit effort below the ceiling passes through",
    env: { CLAUDE_CONSULT_MAX_EFFORT: "high" },
    request: { effort: "low" },
    expectedEffort: "low"
  },
  {
    name: "explicit effort at the ceiling passes through",
    env: { CLAUDE_CONSULT_MAX_EFFORT: "high" },
    request: { effort: "high" },
    expectedEffort: "high"
  },
  {
    name: "Fable default is clamped to a lower ceiling",
    env: { CLAUDE_CONSULT_MAX_EFFORT: "high" },
    request: { model: "claude-fable-5" },
    expectedEffort: "high"
  },
  {
    name: "Fable default stays max without a ceiling",
    env: {},
    request: { model: "claude-fable-5" },
    expectedEffort: "max"
  },
  {
    name: "non-Fable without an explicit effort emits no effort flag",
    env: {},
    request: {},
    expectedEffort: undefined
  }
];

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

function effortArg(args: readonly string[]): string | undefined {
  const index = args.indexOf("--effort");
  return index === -1 ? undefined : args[index + 1];
}

function argValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function continuityEntry(index: number, workspaceDir: string | undefined = WORKSPACE): JournalEntry {
  return {
    ts: `2026-07-11T00:0${index}:00.000Z`,
    tool: "ask_claude",
    sessionId: `123e4567-e89b-12d3-a456-42661417400${index}`,
    workspaceDir,
    model: index % 2 === 0 ? "haiku" : undefined,
    excerpt: `topic ${index}`,
    costUsd: undefined,
    durationMs: undefined
  };
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

  it.each(effortArgCases)("resolves effort in the child argv: $name", async ({ env, request, expectedEffort }) => {
    const harness = makeHarness(env);
    const runner = createRunner(harness.deps);
    await runner.run({ prompt: "choose effort", ...request });
    expect(effortArg(harness.spawnRequests[0]?.args ?? [])).toBe(expectedEffort);
  });

  it("rejects explicit effort above the configured ceiling before spawning", async () => {
    const harness = makeHarness({ CLAUDE_CONSULT_MAX_EFFORT: "high" });
    const runner = createRunner(harness.deps);
    try {
      await runner.run({ prompt: "too deep", effort: "xhigh" });
      expect.unreachable("expected INVALID_INPUT");
    } catch (error) {
      expect(isClaudeConsultError(error)).toBe(true);
      if (isClaudeConsultError(error)) {
        expect(error.code).toBe("INVALID_INPUT");
        expect(error.hint).toContain("low, medium, high");
      }
    }
    expect(harness.spawnRequests).toHaveLength(0);
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

  it("appends a matching newest-first digest to the system prompt without changing the user prompt", async () => {
    const read = vi.fn(async () => [continuityEntry(1), continuityEntry(6), continuityEntry(3), continuityEntry(5), continuityEntry(0), continuityEntry(4), continuityEntry(2), continuityEntry(7, OTHER_WORKSPACE)]);
    const journal: Journal = { append: async () => undefined, read };
    const harness = makeHarness();
    const runner = createRunner({ ...harness.deps, journal });

    await runner.run({ prompt: "user payload", cwd: WORKSPACE, continuityWorkspaceDir: WORKSPACE, appendSystemPrompt: "existing system prompt" });

    const spawn = harness.spawnRequests[0];
    const systemPrompt = argValue(spawn?.args ?? [], "--append-system-prompt");
    expect(spawn?.prompt).toBe("user payload");
    expect(systemPrompt).toMatch(/^existing system prompt\n\n<recent-consultations>/);
    expect(systemPrompt).toContain("topic 6");
    expect(systemPrompt).toContain("topic 2");
    expect(systemPrompt).not.toContain("topic 1");
    expect(systemPrompt).not.toContain("topic 7");
    expect(systemPrompt?.indexOf("topic 6")).toBeLessThan(systemPrompt?.indexOf("topic 5") ?? -1);
    expect(read).toHaveBeenCalledWith({ limit: 20, month: new Date().toISOString().slice(0, 7) });
  });

  it("uses the digest as the whole system prompt when the request has no existing system prompt", async () => {
    const journal: Journal = { append: async () => undefined, read: async () => [continuityEntry(1)] };
    const harness = makeHarness();
    const runner = createRunner({ ...harness.deps, journal });

    await runner.run({ prompt: "fresh", cwd: WORKSPACE, continuityWorkspaceDir: WORKSPACE });

    expect(argValue(harness.spawnRequests[0]?.args ?? [], "--append-system-prompt")).toMatch(/^<recent-consultations>/);
  });

  it("skips continuity for a fresh matching run when the caller opts out", async () => {
    const read = vi.fn(async () => [continuityEntry(1)]);
    const journal: Journal = { append: async () => undefined, read };
    const harness = makeHarness();

    await createRunner({ ...harness.deps, journal }).run({
      prompt: "clean context",
      cwd: WORKSPACE,
      continuityWorkspaceDir: WORKSPACE,
      skipContinuity: true,
      appendSystemPrompt: "existing"
    });

    expect(read).not.toHaveBeenCalled();
    expect(argValue(harness.spawnRequests[0]?.args ?? [], "--append-system-prompt")).toBe("existing");
  });

  it("does not let caller enablement inject continuity into resumed conversations", async () => {
    const read = vi.fn(async () => [continuityEntry(1)]);
    const journal: Journal = { append: async () => undefined, read };
    const harness = makeHarness();
    const runner = createRunner({ ...harness.deps, journal });

    await runner.run({ prompt: "resume", cwd: WORKSPACE, continuityWorkspaceDir: WORKSPACE, skipContinuity: false, sessionId: SESSION_ID, appendSystemPrompt: "existing" });

    expect(read).not.toHaveBeenCalled();
    expect(argValue(harness.spawnRequests[0]?.args ?? [], "--append-system-prompt")).toBe("existing");
  });

  it("does not read continuity when the journal, execution cwd, or explicit continuity workspace is absent", async () => {
    const withoutJournal = makeHarness();
    await createRunner(withoutJournal.deps).run({ prompt: "fresh", cwd: WORKSPACE, continuityWorkspaceDir: WORKSPACE });
    expect(argValue(withoutJournal.spawnRequests[0]?.args ?? [], "--append-system-prompt")).toBeUndefined();

    const read = vi.fn(async () => [continuityEntry(1)]);
    const journal: Journal = { append: async () => undefined, read };
    const withoutCwd = makeHarness();
    await createRunner({ ...withoutCwd.deps, journal }).run({ prompt: "fresh", continuityWorkspaceDir: WORKSPACE });
    expect(read).not.toHaveBeenCalled();
    expect(argValue(withoutCwd.spawnRequests[0]?.args ?? [], "--append-system-prompt")).toBeUndefined();

    const inferredOnly = makeHarness();
    await createRunner({ ...inferredOnly.deps, journal }).run({ prompt: "fresh", cwd: WORKSPACE });
    expect(read).not.toHaveBeenCalled();
    expect(argValue(inferredOnly.spawnRequests[0]?.args ?? [], "--append-system-prompt")).toBeUndefined();
  });

  it("does not let caller enablement override the owner kill switch", async () => {
    const read = vi.fn(async () => [continuityEntry(1)]);
    const journal: Journal = { append: async () => undefined, read };
    const harness = makeHarness({ CLAUDE_CONSULT_CONTINUITY: "0" });

    await createRunner({ ...harness.deps, journal }).run({ prompt: "fresh", cwd: WORKSPACE, continuityWorkspaceDir: WORKSPACE, skipContinuity: false, appendSystemPrompt: "existing" });

    expect(read).not.toHaveBeenCalled();
    expect(argValue(harness.spawnRequests[0]?.args ?? [], "--append-system-prompt")).toBe("existing");
  });

  it("falls back to the original prompt and still spawns when continuity reading fails", async () => {
    const journal: Journal = { append: async () => undefined, read: async () => { throw new Error("disk unavailable"); } };
    const harness = makeHarness();

    await expect(createRunner({ ...harness.deps, journal }).run({ prompt: "user payload", cwd: WORKSPACE, continuityWorkspaceDir: WORKSPACE, appendSystemPrompt: "existing" })).resolves.toMatchObject({ sessionId: SESSION_ID });

    expect(harness.spawnRequests).toHaveLength(1);
    expect(harness.spawnRequests[0]?.prompt).toBe("user payload");
    expect(argValue(harness.spawnRequests[0]?.args ?? [], "--append-system-prompt")).toBe("existing");
  });

  it("falls back to the original prompt when a malformed journal entry cannot be composed", async () => {
    const malformed = { ...continuityEntry(1), tool: 42 as unknown as string };
    const journal: Journal = { append: async () => undefined, read: async () => [malformed] };
    const harness = makeHarness();

    await createRunner({ ...harness.deps, journal }).run({ prompt: "user payload", cwd: WORKSPACE, continuityWorkspaceDir: WORKSPACE, appendSystemPrompt: "existing" });

    expect(harness.spawnRequests).toHaveLength(1);
    expect(argValue(harness.spawnRequests[0]?.args ?? [], "--append-system-prompt")).toBe("existing");
  });

  it("stops waiting for a stalled continuity read and still spawns", async () => {
    vi.useFakeTimers();
    try {
      const journal: Journal = { append: async () => undefined, read: async () => new Promise<readonly JournalEntry[]>(() => undefined) };
      const harness = makeHarness();
      const pending = createRunner({ ...harness.deps, journal }).run({ prompt: "user payload", cwd: WORKSPACE, continuityWorkspaceDir: WORKSPACE, appendSystemPrompt: "existing" });

      await vi.advanceTimersByTimeAsync(LIMITS.continuityReadTimeoutMs - 1);
      expect(harness.spawnRequests).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);

      expect(harness.spawnRequests).toHaveLength(1);
      await expect(pending).resolves.toMatchObject({ sessionId: SESSION_ID });
      expect(argValue(harness.spawnRequests[0]?.args ?? [], "--append-system-prompt")).toBe("existing");
    } finally {
      vi.useRealTimers();
    }
  });

  it("validates depth, schema, and add-dir inputs before reading continuity", async () => {
    const read = vi.fn(async () => [continuityEntry(1)]);
    const journal: Journal = { append: async () => undefined, read };
    const harness = makeHarness();
    const runner = createRunner({ ...harness.deps, journal });

    await expectCode(runner.run({ prompt: "deep", cwd: WORKSPACE, continuityWorkspaceDir: WORKSPACE, depth: "deep" }), "INVALID_INPUT");
    await expectCode(runner.run({ prompt: "schema", cwd: WORKSPACE, continuityWorkspaceDir: WORKSPACE, jsonSchema: "not json" }), "INVALID_INPUT");
    await expectCode(runner.run({ prompt: "directory", cwd: WORKSPACE, continuityWorkspaceDir: WORKSPACE, addDirs: ["relative"] }), "INVALID_INPUT");

    expect(read).not.toHaveBeenCalled();
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
