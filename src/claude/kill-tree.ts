import { spawn } from "node:child_process";

export const KILL_GRACE_MS = 5_000;

export interface KillTreeDeps {
  readonly platform: string;
  readonly exec: (command: string, args: readonly string[]) => void;
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
}

export function killProcessTree(pid: number, deps: KillTreeDeps): void {
  if (deps.platform === "win32") {
    deps.exec("taskkill", ["/PID", String(pid), "/T", "/F"]);
    return;
  }
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      deps.kill(-pid, signal);
    } catch {
      // The process group is already gone; nothing left to clean up.
    }
  };
  signalGroup("SIGTERM");
  deps.setTimer(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
}

export function createDefaultKillTreeDeps(): KillTreeDeps {
  return Object.freeze({
    platform: process.platform,
    exec: (command: string, args: readonly string[]) => {
      const child = spawn(command, [...args], { stdio: "ignore", windowsHide: true });
      child.on("error", () => {
        // taskkill itself failing leaves nothing actionable at this layer.
      });
      child.unref();
    },
    kill: (pid: number, signal: NodeJS.Signals) => process.kill(pid, signal),
    setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms).unref()
  });
}
