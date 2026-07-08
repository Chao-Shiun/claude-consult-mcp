import { access, constants } from "node:fs/promises";
import { ENV } from "../constants.js";
import { ClaudeConsultError } from "../errors.js";
import type { Config } from "../config.js";

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

export interface LocatorOptions {
  readonly claudeBin: string | undefined;
  readonly platform: string;
  readonly pathValue: string | undefined;
  readonly pathExtValue: string | undefined;
  readonly fileExists: (filePath: string) => Promise<boolean>;
}

export interface ClaudeLocator {
  readonly locate: () => Promise<string>;
}

function notFound(message: string): never {
  throw new ClaudeConsultError("CLAUDE_NOT_FOUND", message, `install Claude Code with \`npm install -g @anthropic-ai/claude-code\` and run \`claude\` once to log in, or set ${ENV.claudeBin} to the full path of the claude binary`);
}

function candidateNames(platform: string, pathExtValue: string | undefined): readonly string[] {
  if (platform !== "win32") {
    return ["claude"];
  }
  const extensions = (pathExtValue ?? DEFAULT_PATHEXT).split(";").filter((extension) => extension.startsWith("."));
  const names = extensions.flatMap((extension) => [`claude${extension.toLowerCase()}`, `claude${extension}`]);
  return [...new Set(names)];
}

async function scanPath(options: LocatorOptions): Promise<string | undefined> {
  const listSeparator = options.platform === "win32" ? ";" : ":";
  const dirSeparator = options.platform === "win32" ? "\\" : "/";
  const dirs = (options.pathValue ?? "").split(listSeparator).map((dir) => dir.replace(/[\\/]+$/, "")).filter((dir) => dir.trim() !== "");
  const names = candidateNames(options.platform, options.pathExtValue);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = `${dir}${dirSeparator}${name}`;
      if (await options.fileExists(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export function createClaudeLocator(options: LocatorOptions): ClaudeLocator {
  let resolved: string | undefined;

  const locate = async (): Promise<string> => {
    if (resolved !== undefined) {
      return resolved;
    }
    if (options.claudeBin !== undefined) {
      if (await options.fileExists(options.claudeBin)) {
        resolved = options.claudeBin;
        return resolved;
      }
      notFound(`the ${ENV.claudeBin} path does not exist: ${options.claudeBin}`);
    }
    const found = await scanPath(options);
    if (found === undefined) {
      notFound("Claude Code CLI not found on PATH");
    }
    resolved = found;
    return resolved;
  };

  return Object.freeze({ locate });
}

export function createDefaultClaudeLocator(config: Config): ClaudeLocator {
  const fileExists = async (filePath: string): Promise<boolean> => {
    try {
      const mode = process.platform === "win32" ? constants.F_OK : constants.F_OK | constants.X_OK;
      await access(filePath, mode);
      return true;
    } catch {
      return false;
    }
  };
  return createClaudeLocator({
    claudeBin: config.claudeBin,
    platform: process.platform,
    pathValue: process.env.PATH,
    pathExtValue: process.env.PATHEXT,
    fileExists
  });
}
