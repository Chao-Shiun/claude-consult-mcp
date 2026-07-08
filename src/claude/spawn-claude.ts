import crossSpawn from "cross-spawn";
import { ENV, LIMITS } from "../constants.js";
import { ClaudeConsultError } from "../errors.js";
import type { Logger } from "../logger.js";
import { createDefaultKillTreeDeps, killProcessTree } from "./kill-tree.js";
import type { RawRunOutput } from "./parse-output.js";

export interface SpawnOptionsSubset {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly windowsHide: boolean;
  readonly detached: boolean;
  readonly stdio: readonly ["pipe", "pipe", "pipe"];
}

export interface ClaudeChildProcess {
  readonly pid?: number | undefined;
  readonly stdin: NodeJS.WritableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface SpawnClaudeRequest {
  readonly binPath: string;
  readonly args: readonly string[];
  readonly prompt: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
}

export interface SpawnClaudeDeps {
  readonly platform: string;
  readonly spawnFn: (command: string, args: readonly string[], options: SpawnOptionsSubset) => ClaudeChildProcess;
  readonly killTree: (pid: number) => void;
  readonly logger: Logger;
  readonly onSpawned?: ((kill: () => void) => (() => void) | void) | undefined;
}

export function spawnClaude(request: SpawnClaudeRequest, deps: SpawnClaudeDeps): Promise<RawRunOutput> {
  return new Promise((resolve, reject) => {
    const child = deps.spawnFn(request.binPath, request.args, {
      cwd: request.cwd,
      env: request.env,
      windowsHide: true,
      detached: deps.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });

    let settled = false;
    let timedOut = false;
    let oversized = false;
    let stdoutBytes = 0;
    const stdoutChunks: Buffer[] = [];
    let stderrTail = "";

    const kill = (): void => {
      if (child.pid !== undefined) {
        deps.killTree(child.pid);
      }
    };
    const unregister = deps.onSpawned?.(kill);

    const timer = setTimeout(() => {
      timedOut = true;
      deps.logger.info(`claude run exceeded ${request.timeoutMs} ms; killing pid ${child.pid}`);
      kill();
    }, request.timeoutMs);

    const settle = (finish: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (typeof unregister === "function") {
        unregister();
      }
      finish();
    };

    child.on("error", (error: Error) => settle(() => {
      reject(new ClaudeConsultError("CLAUDE_SPAWN_FAILED", `failed to spawn claude at ${request.binPath}: ${error.message}`, `verify the path is executable, or set ${ENV.claudeBin} to the correct binary`));
    }));

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      stdoutBytes += data.length;
      if (stdoutBytes > LIMITS.stdoutMaxBytes) {
        if (!oversized) {
          oversized = true;
          deps.logger.info(`claude stdout exceeded ${LIMITS.stdoutMaxBytes} bytes; killing pid ${child.pid}`);
          kill();
        }
        return;
      }
      stdoutChunks.push(data);
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-LIMITS.stderrTailBytes);
    });

    child.on("close", (code: number | null) => settle(() => {
      if (timedOut) {
        reject(new ClaudeConsultError("CLAUDE_TIMEOUT", `claude run exceeded ${request.timeoutMs} ms and was terminated`, `raise ${ENV.timeoutMs}, and check tool_timeout_sec for this server in ~/.codex/config.toml`));
        return;
      }
      if (oversized) {
        reject(new ClaudeConsultError("OUTPUT_TOO_LARGE", `claude stdout exceeded ${LIMITS.stdoutMaxBytes} bytes`, "narrow the question or review fewer files"));
        return;
      }
      resolve({ stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderrTail, exitCode: code });
    }));

    if (child.stdin !== null) {
      child.stdin.on("error", () => {
        deps.logger.debug("claude stdin closed before the prompt was fully written");
      });
      child.stdin.write(request.prompt);
      child.stdin.end();
    }
  });
}

export function createDefaultSpawnDeps(logger: Logger, onSpawned?: (kill: () => void) => (() => void) | void): SpawnClaudeDeps {
  const killDeps = createDefaultKillTreeDeps();
  return Object.freeze({
    platform: process.platform,
    spawnFn: (command: string, args: readonly string[], options: SpawnOptionsSubset): ClaudeChildProcess => crossSpawn(command, [...args], {
      cwd: options.cwd,
      env: { ...options.env },
      windowsHide: options.windowsHide,
      detached: options.detached,
      stdio: ["pipe", "pipe", "pipe"]
    }),
    killTree: (pid: number) => killProcessTree(pid, killDeps),
    logger,
    onSpawned
  });
}
