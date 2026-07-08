import { describe, expect, it, vi } from "vitest";
import { LIMITS } from "../../src/constants.js";
import { isClaudeConsultError } from "../../src/errors.js";
import { createLogger } from "../../src/logger.js";
import { spawnClaude, type SpawnClaudeDeps, type SpawnClaudeRequest } from "../../src/claude/spawn-claude.js";
import { FakeClaudeProcess } from "../helpers/fake-claude-process.js";

const silentLogger = createLogger("silent", { write: () => true });

function makeRequest(overrides: Partial<SpawnClaudeRequest> = {}): SpawnClaudeRequest {
  return {
    binPath: "C:\\tools\\claude.cmd",
    args: ["-p", "--output-format", "json"],
    prompt: "hello claude",
    cwd: "C:\\work",
    env: { PATH: "C:\\bin" },
    timeoutMs: 60_000,
    ...overrides
  };
}

interface Harness {
  child: FakeClaudeProcess;
  spawnCalls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }>;
  killedPids: number[];
  deps: SpawnClaudeDeps;
}

function makeHarness(platform = "win32", child = new FakeClaudeProcess(), onSpawned?: SpawnClaudeDeps["onSpawned"]): Harness {
  const spawnCalls: Harness["spawnCalls"] = [];
  const killedPids: number[] = [];
  return {
    child,
    spawnCalls,
    killedPids,
    deps: {
      platform,
      spawnFn: (command, args, options) => {
        spawnCalls.push({ command, args, options: options as unknown as Record<string, unknown> });
        return child;
      },
      killTree: (pid) => {
        killedPids.push(pid);
      },
      logger: silentLogger,
      onSpawned
    }
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("spawnClaude", () => {
  it("spawns with pipes, writes the prompt to stdin, and resolves the raw output", async () => {
    const harness = makeHarness("win32");
    const pending = spawnClaude(makeRequest(), harness.deps);
    await flush();
    expect(harness.spawnCalls).toHaveLength(1);
    const call = harness.spawnCalls[0];
    expect(call?.command).toBe("C:\\tools\\claude.cmd");
    expect(call?.args).toEqual(["-p", "--output-format", "json"]);
    expect(call?.options["cwd"]).toBe("C:\\work");
    expect(call?.options["windowsHide"]).toBe(true);
    expect(call?.options["detached"]).toBe(false);
    expect(call?.options["stdio"]).toEqual(["pipe", "pipe", "pipe"]);
    expect(harness.child.stdinData).toBe("hello claude");
    expect(harness.child.stdinEnded).toBe(true);
    harness.child.emitStdout("part one ");
    harness.child.emitStdout("part two");
    harness.child.emitStderr("some warning");
    await flush();
    harness.child.exit(0);
    const raw = await pending;
    expect(raw.stdout).toBe("part one part two");
    expect(raw.stderrTail).toBe("some warning");
    expect(raw.exitCode).toBe(0);
  });

  it("spawns detached on POSIX so the process group can be signaled", async () => {
    const harness = makeHarness("darwin");
    const pending = spawnClaude(makeRequest(), harness.deps);
    await flush();
    expect(harness.spawnCalls[0]?.options["detached"]).toBe(true);
    harness.child.exit(0);
    const raw = await pending;
    expect(raw.exitCode).toBe(0);
  });

  it("resolves nonzero exits as raw output for the parser to classify", async () => {
    const harness = makeHarness();
    const pending = spawnClaude(makeRequest(), harness.deps);
    await flush();
    harness.child.emitStdout("{}");
    await flush();
    harness.child.exit(2);
    const raw = await pending;
    expect(raw.exitCode).toBe(2);
  });

  it("rejects with CLAUDE_SPAWN_FAILED when the process cannot start", async () => {
    const harness = makeHarness();
    const pending = spawnClaude(makeRequest(), harness.deps);
    await flush();
    harness.child.failSpawn(new Error("EACCES: permission denied"));
    try {
      await pending;
      expect.unreachable("expected a spawn failure");
    } catch (error) {
      expect(isClaudeConsultError(error)).toBe(true);
      if (isClaudeConsultError(error)) {
        expect(error.code).toBe("CLAUDE_SPAWN_FAILED");
        expect(error.message).toContain("C:\\tools\\claude.cmd");
        expect(error.message).toContain("EACCES");
      }
    }
  });

  it("kills the process tree and rejects with CLAUDE_TIMEOUT when the deadline passes", async () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness();
      const pending = spawnClaude(makeRequest({ timeoutMs: 5_000 }), harness.deps);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(harness.killedPids).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.killedPids).toEqual([4321]);
      harness.child.exit(null, "SIGTERM");
      try {
        await pending;
        expect.unreachable("expected a timeout");
      } catch (error) {
        expect(isClaudeConsultError(error)).toBe(true);
        if (isClaudeConsultError(error)) {
          expect(error.code).toBe("CLAUDE_TIMEOUT");
          expect(error.message).toContain("5000");
          expect(error.hint).toContain("tool_timeout_sec");
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("kills the child and rejects with OUTPUT_TOO_LARGE when stdout exceeds the cap", async () => {
    const harness = makeHarness();
    const pending = spawnClaude(makeRequest(), harness.deps);
    await flush();
    const half = Buffer.alloc(Math.ceil(LIMITS.stdoutMaxBytes / 2) + 1, 120);
    harness.child.emitStdout(half);
    await flush();
    harness.child.emitStdout(half);
    await flush();
    expect(harness.killedPids).toEqual([4321]);
    harness.child.exit(null, "SIGKILL");
    try {
      await pending;
      expect.unreachable("expected an oversized-output failure");
    } catch (error) {
      expect(isClaudeConsultError(error)).toBe(true);
      if (isClaudeConsultError(error)) {
        expect(error.code).toBe("OUTPUT_TOO_LARGE");
      }
    }
  });

  it("survives stdin errors from a fast-exiting child", async () => {
    const harness = makeHarness();
    const pending = spawnClaude(makeRequest(), harness.deps);
    await flush();
    harness.child.stdin.emit("error", new Error("EPIPE"));
    harness.child.emitStdout("{}");
    await flush();
    harness.child.exit(0);
    const raw = await pending;
    expect(raw.exitCode).toBe(0);
  });

  it("registers a kill handle via onSpawned and unregisters after settling", async () => {
    let capturedKill: (() => void) | undefined;
    let unregistered = false;
    const harness = makeHarness("win32", new FakeClaudeProcess(777), (kill) => {
      capturedKill = kill;
      return () => {
        unregistered = true;
      };
    });
    const pending = spawnClaude(makeRequest(), harness.deps);
    await flush();
    expect(capturedKill).toBeDefined();
    capturedKill?.();
    expect(harness.killedPids).toEqual([777]);
    harness.child.exit(0);
    await pending.catch(() => undefined);
    expect(unregistered).toBe(true);
  });
});
