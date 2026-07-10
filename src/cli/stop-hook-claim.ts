import path from "node:path";
import { LIMITS } from "../constants.js";
import { truncateToBytes } from "../tools/exhibits.js";

export interface ClaimReadOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export type ClaimInputStream = NodeJS.ReadableStream & { readonly isTTY?: boolean | undefined };

export function startClaimRead(stdin: ClaimInputStream, options: ClaimReadOptions = {}): () => Promise<string | undefined> {
  if (stdin.isTTY === true) {
    return async () => undefined;
  }

  const maxBytes = options.maxBytes ?? LIMITS.gateStdinMaxBytes;
  const timeoutMs = options.timeoutMs ?? LIMITS.gateStdinTimeoutMs;
  const pending = new Promise<string | undefined>((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflowed = false;
    let settled = false;

    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maxBytes - bytes);
      if (buffer.length > remaining) {
        if (remaining > 0) {
          chunks.push(buffer.subarray(0, remaining));
          bytes += remaining;
        }
        overflowed = true;
        return;
      }
      chunks.push(buffer);
      bytes += buffer.length;
    };
    const cleanup = (terminal: boolean): void => {
      clearTimeout(timer);
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      if (terminal) {
        stdin.removeListener("error", onError);
      } else {
        stdin.resume();
      }
    };
    const finish = (useData: boolean, terminal: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup(terminal);
      resolve(useData && !overflowed && bytes > 0 ? Buffer.concat(chunks, bytes).toString("utf8") : undefined);
    };
    const onEnd = (): void => finish(true, true);
    const onError = (): void => finish(false, true);
    const timer = setTimeout(() => finish(true, false), timeoutMs);

    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onError);
    stdin.resume();
  });

  return () => pending;
}

function cwdMatches(actual: string, expected: string): boolean {
  const left = path.resolve(actual);
  const right = path.resolve(expected);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function parseStopHookClaim(raw: string | undefined, expectedCwd: string): string | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const payload = parsed as Record<string, unknown>;
    if (payload.hook_event_name !== "Stop") {
      return undefined;
    }
    if (typeof payload.cwd === "string" && !cwdMatches(payload.cwd, expectedCwd)) {
      return undefined;
    }
    const message = payload.last_assistant_message;
    if (typeof message !== "string" || message.trim() === "") {
      return undefined;
    }
    const truncated = truncateToBytes(message, LIMITS.gateClaimMaxBytes);
    return truncated === message ? message : `${truncated}\n(truncated)`;
  } catch {
    return undefined;
  }
}
