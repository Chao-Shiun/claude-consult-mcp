import { describe, expect, it, vi } from "vitest";
import { KILL_GRACE_MS, killProcessTree } from "../../src/claude/kill-tree.js";

interface Recorded {
  execCalls: Array<{ command: string; args: readonly string[] }>;
  killCalls: Array<{ pid: number; signal: string }>;
}

function createDeps(platform: string, options: { killThrows?: boolean } = {}): { recorded: Recorded; deps: Parameters<typeof killProcessTree>[1] } {
  const recorded: Recorded = { execCalls: [], killCalls: [] };
  return {
    recorded,
    deps: {
      platform,
      exec: (command, args) => {
        recorded.execCalls.push({ command, args });
      },
      kill: (pid, signal) => {
        recorded.killCalls.push({ pid, signal });
        if (options.killThrows) {
          throw new Error("ESRCH");
        }
      },
      setTimer: (fn, ms) => setTimeout(fn, ms)
    }
  };
}

describe("killProcessTree", () => {
  it("uses taskkill with the full-tree flags on Windows", () => {
    const { recorded, deps } = createDeps("win32");
    killProcessTree(1234, deps);
    expect(recorded.execCalls).toEqual([{ command: "taskkill", args: ["/PID", "1234", "/T", "/F"] }]);
    expect(recorded.killCalls).toEqual([]);
  });

  it("signals the process group with SIGTERM then escalates to SIGKILL on POSIX", () => {
    vi.useFakeTimers();
    try {
      const { recorded, deps } = createDeps("darwin");
      killProcessTree(1234, deps);
      expect(recorded.killCalls).toEqual([{ pid: -1234, signal: "SIGTERM" }]);
      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(recorded.killCalls).toEqual([
        { pid: -1234, signal: "SIGTERM" },
        { pid: -1234, signal: "SIGKILL" }
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows kill errors for already-dead process groups", () => {
    vi.useFakeTimers();
    try {
      const { deps } = createDeps("linux", { killThrows: true });
      expect(() => killProcessTree(999, deps)).not.toThrow();
      expect(() => vi.advanceTimersByTime(KILL_GRACE_MS)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes a five second grace period", () => {
    expect(KILL_GRACE_MS).toBe(5_000);
  });
});
