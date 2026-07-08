import { stat } from "node:fs/promises";
import path from "node:path";
import { ClaudeConsultError } from "../errors.js";

export interface PathInfo {
  readonly path: string;
  readonly isDirectory: boolean | undefined;
}

export interface PathAnalysis {
  readonly dirs: readonly string[];
  readonly cwd: string | undefined;
  readonly pathList: string;
}

export function commonAncestor(dirs: readonly string[]): string | undefined {
  const [first, ...rest] = dirs;
  if (first === undefined) {
    return undefined;
  }
  const separator = first.includes("\\") ? "\\" : "/";
  let prefixParts = first.split(/[\\/]/);
  for (const dir of rest) {
    const parts = dir.split(/[\\/]/);
    let shared = 0;
    while (shared < prefixParts.length && shared < parts.length && prefixParts[shared]?.toLowerCase() === parts[shared]?.toLowerCase()) {
      shared += 1;
    }
    prefixParts = prefixParts.slice(0, shared);
    if (prefixParts.length === 0) {
      return undefined;
    }
  }
  const joined = prefixParts.join(separator);
  // An empty result (POSIX paths sharing only "/") or a bare drive letter
  // (Windows paths sharing only "C:") is not a meaningful ancestor. Returning
  // undefined lets the caller fall back to a specific path instead of widening
  // the working directory to a filesystem or drive root.
  if (joined === "" || /^[A-Za-z]:$/.test(joined)) {
    return undefined;
  }
  return joined;
}

export async function inspectPaths(paths: readonly string[]): Promise<readonly PathInfo[]> {
  return Promise.all(paths.map(async (candidate) => {
    try {
      const info = await stat(candidate);
      return { path: candidate, isDirectory: info.isDirectory() };
    } catch {
      return { path: candidate, isDirectory: undefined };
    }
  }));
}

export async function analyzePaths(paths: readonly string[], workspaceDir: string | undefined): Promise<PathAnalysis> {
  const inspected = await inspectPaths(paths);
  const missing = inspected.filter((entry) => entry.isDirectory === undefined).map((entry) => entry.path);
  if (missing.length > 0) {
    throw new ClaudeConsultError("INVALID_INPUT", `paths do not exist: ${missing.join(", ")}`, "pass absolute paths that exist on this machine");
  }
  const dirs = [...new Set(inspected.map((entry) => entry.isDirectory === true ? entry.path : path.dirname(entry.path)))];
  return Object.freeze({
    dirs,
    cwd: workspaceDir ?? commonAncestor(dirs) ?? dirs[0],
    pathList: paths.map((entry) => `- ${entry}`).join("\n")
  });
}
