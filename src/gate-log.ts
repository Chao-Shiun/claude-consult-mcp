import path from "node:path";
import { ENV, PATTERNS } from "./constants.js";

function readEnv(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function isValidLocalAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) && !PATTERNS.uncOrDevice.test(value);
}

export function resolveGateLogPath(env: Readonly<Record<string, string | undefined>>, printErr: (line: string) => void): string | undefined {
  const gateLog = readEnv(env, ENV.gateLog);
  if (gateLog !== undefined) {
    if (!isValidLocalAbsolutePath(gateLog)) {
      printErr(`review-gate: findings log disabled (invalid ${ENV.gateLog})`);
      return undefined;
    }
    return gateLog;
  }
  const journalDir = readEnv(env, ENV.journalDir);
  if (journalDir !== undefined) {
    if (!isValidLocalAbsolutePath(journalDir)) {
      printErr(`review-gate: findings log disabled (invalid ${ENV.journalDir})`);
      return undefined;
    }
    return path.join(journalDir, "review-gate.log");
  }
  return undefined;
}
