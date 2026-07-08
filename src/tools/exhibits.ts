import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { LIMITS, PATTERNS } from "../constants.js";

export interface ExhibitBudget {
  remainingBytes: number;
}

export interface ExtractFileExhibitRequest {
  readonly workspaceDir: string;
  readonly ref: string;
  readonly budget: ExhibitBudget;
}

export interface NeutralExhibit {
  readonly ref: string;
  readonly content: string;
}

interface ParsedFileRef {
  readonly filePath: string;
  readonly startLine: number | undefined;
  readonly endLine: number | undefined;
}

export function createExhibitBudget(maxBytes = LIMITS.exhibitMaxBytes): ExhibitBudget {
  return { remainingBytes: maxBytes };
}

function unavailable(ref: string, reason: string): NeutralExhibit {
  return Object.freeze({ ref, content: `(exhibit unavailable: ${reason})` });
}

function hasParentSegment(value: string): boolean {
  return value.split(/[\\/]+/).includes("..");
}

function parseFileRef(ref: string): ParsedFileRef | undefined {
  const trimmed = ref.trim();
  if (trimmed === "") {
    return undefined;
  }
  const rangeMatch = /^(.*):([1-9]\d*)(?:-([1-9]\d*))?$/.exec(trimmed);
  if (rangeMatch === null) {
    return Object.freeze({ filePath: trimmed, startLine: undefined, endLine: undefined });
  }
  const startLine = Number(rangeMatch[2]);
  const endLine = rangeMatch[3] === undefined ? startLine : Number(rangeMatch[3]);
  if (endLine < startLine) {
    return undefined;
  }
  return Object.freeze({ filePath: rangeMatch[1] ?? "", startLine, endLine });
}

function isWithinWorkspace(workspaceDir: string, candidate: string): boolean {
  const relative = path.relative(workspaceDir, candidate);
  return relative === "" || (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function truncateToBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  let bytes = 0;
  let truncated = "";
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) {
      break;
    }
    truncated += char;
    bytes += charBytes;
  }
  return truncated;
}

function selectLines(content: string, parsed: ParsedFileRef): string {
  const lines = content.split(/\r?\n/);
  const startLine = parsed.startLine ?? 1;
  const endLine = parsed.endLine ?? lines.length;
  const first = Math.max(1, startLine - 5);
  const last = Math.min(lines.length, endLine + 5);
  return lines.slice(first - 1, last).map((line, index) => `${first + index}: ${line}`).join("\n");
}

export async function extractFileExhibit(request: ExtractFileExhibitRequest): Promise<NeutralExhibit> {
  const parsed = parseFileRef(request.ref);
  if (parsed === undefined || parsed.filePath === "") {
    return unavailable(request.ref, "invalid file reference");
  }
  if (!path.isAbsolute(request.workspaceDir) || PATTERNS.uncOrDevice.test(request.workspaceDir)) {
    return unavailable(request.ref, "workspace_dir must be a local absolute path");
  }
  if (PATTERNS.uncOrDevice.test(parsed.filePath)) {
    return unavailable(request.ref, "UNC and device paths are not allowed");
  }
  if (hasParentSegment(parsed.filePath)) {
    return unavailable(request.ref, "path escapes are not allowed");
  }

  const workspace = path.resolve(request.workspaceDir);
  const candidate = path.resolve(workspace, parsed.filePath);
  if (!isWithinWorkspace(workspace, candidate)) {
    return unavailable(request.ref, "path is outside workspace_dir");
  }
  if (request.budget.remainingBytes <= 0) {
    return unavailable(request.ref, "exhibit byte cap reached");
  }

  try {
    const info = await stat(candidate);
    if (!info.isFile()) {
      return unavailable(request.ref, "path is not a file");
    }
    const file = await readFile(candidate, "utf8");
    const snippet = selectLines(file, parsed);
    const capped = truncateToBytes(snippet, request.budget.remainingBytes);
    request.budget.remainingBytes -= Buffer.byteLength(capped, "utf8");
    return Object.freeze({ ref: request.ref, content: capped });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "unknown";
    return unavailable(request.ref, `file could not be read (${code})`);
  }
}
