import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { LIMITS, PATTERNS } from "../constants.js";
import { truncateToBytes } from "./exhibits.js";
import { absolutePathSchema, type ConsultTool } from "./shared-schemas.js";
import type { ToolResult } from "./tool-result.js";

export const GATE_FINDINGS_DESCRIPTION = "Read recent review-gate findings from the configured durable log. Call this when starting work in a repository where the automatic review gate is installed, or when the user mentions review-gate findings. Each entry's session_id can be passed to claude_continue to discuss that review with the Claude session that produced it.";

const argsSchema = z.object({
  workspace_dir: absolutePathSchema.optional(),
  limit: z.number().int().min(1).max(20).optional()
});

interface GateFindingEntry {
  readonly ts: string;
  readonly model: string;
  readonly sessionId: string;
  readonly repo: string | undefined;
  readonly body: string;
}

export interface GateFindingsOptions {
  readonly platform?: NodeJS.Platform | undefined;
}

const SESSION_ID_SOURCE = PATTERNS.sessionId.source.replace(/^\^/, "").replace(/\$$/, "");
const MODEL_SOURCE = PATTERNS.model.source.replace(/^\^/, "").replace(/\$$/, "");
const HEADER_PATTERN = new RegExp(`^## (\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z) \\| model: (${MODEL_SOURCE}) \\| session_id: (${SESSION_ID_SOURCE})(?: \\| repo: (.*))?$`);

async function readLogTail(logPath: string): Promise<"missing" | "unreadable" | string> {
  let info: { readonly size: number };
  try {
    info = await stat(logPath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
  try {
    if (info.size <= LIMITS.gateFindingsTailBytes) {
      return await readFile(logPath, "utf8");
    }
    const handle = await open(logPath, "r");
    try {
      const buffer = Buffer.alloc(LIMITS.gateFindingsTailBytes);
      await handle.read(buffer, 0, LIMITS.gateFindingsTailBytes, info.size - LIMITS.gateFindingsTailBytes);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "unreadable";
  }
}

function parseEntries(content: string): readonly GateFindingEntry[] {
  const entries: GateFindingEntry[] = [];
  let current: { ts: string; model: string; sessionId: string; repo: string | undefined; bodyLines: string[] } | undefined;
  const pushCurrent = (): void => {
    if (current === undefined) {
      return;
    }
    entries.push(Object.freeze({
      ts: current.ts,
      model: current.model,
      sessionId: current.sessionId,
      repo: current.repo,
      body: current.bodyLines.join("\n").replace(/\n+$/, "")
    }));
  };
  for (const line of content.split(/\r?\n/)) {
    const match = HEADER_PATTERN.exec(line);
    if (match !== null) {
      pushCurrent();
      current = {
        ts: match[1] ?? "",
        model: match[2] ?? "",
        sessionId: match[3] ?? "",
        repo: match[4],
        bodyLines: []
      };
      continue;
    }
    current?.bodyLines.push(line);
  }
  pushCurrent();
  return Object.freeze(entries);
}

function normalizeRepo(value: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function matchesWorkspace(entry: GateFindingEntry, workspaceDir: string | undefined, platform: NodeJS.Platform): boolean {
  if (workspaceDir === undefined) {
    return true;
  }
  return entry.repo !== undefined && normalizeRepo(entry.repo, platform) === normalizeRepo(workspaceDir, platform);
}

function renderEntry(entry: GateFindingEntry, index: number): string {
  const truncated = Buffer.byteLength(entry.body, "utf8") > LIMITS.gateFindingsEntryBytes;
  const body = truncated ? truncateToBytes(entry.body, LIMITS.gateFindingsEntryBytes) : entry.body;
  return [
    `${index + 1}. [${entry.ts}] model: ${entry.model} | session_id: ${entry.sessionId} | repo: ${entry.repo ?? "(unknown)"}`,
    truncated ? `${body}\n(truncated)` : body
  ].join("\n");
}

export function createGateFindingsTool(logPath: string, options: GateFindingsOptions = {}): ConsultTool {
  const platform = options.platform ?? process.platform;
  return Object.freeze({
    name: "claude_gate_findings",
    title: "Claude Gate Findings",
    description: GATE_FINDINGS_DESCRIPTION,
    inputSchema: {
      workspace_dir: absolutePathSchema.optional().describe("Optional repository path filter. Only entries whose repo field matches this path are returned."),
      limit: z.number().int().min(1).max(20).optional().describe("Maximum findings to list, defaulting to 5.")
    },
    execute: async (rawArgs: Record<string, unknown>): Promise<ToolResult> => {
      const args = argsSchema.parse(rawArgs);
      const content = await readLogTail(logPath);
      if (content === "missing") {
        return { content: [{ type: "text", text: "No review-gate findings are recorded yet." }] };
      }
      if (content === "unreadable") {
        return { content: [{ type: "text", text: "No readable review-gate findings were found." }] };
      }
      const entries = [...parseEntries(content)].sort((left, right) => right.ts.localeCompare(left.ts));
      const filtered = entries.filter((entry) => matchesWorkspace(entry, args.workspace_dir, platform));
      if (filtered.length === 0) {
        const heldBack = args.workspace_dir === undefined ? 0 : entries.length;
        const note = heldBack > 0 ? `\n\nNote: ${heldBack} entries were held back by the workspace_dir filter.` : "";
        return { content: [{ type: "text", text: `No readable review-gate findings were found.${note}` }] };
      }
      const limit = args.limit ?? 5;
      const heldBack = args.workspace_dir === undefined ? 0 : entries.length - filtered.length;
      const body = filtered.slice(0, limit).map(renderEntry).join("\n\n");
      const note = heldBack > 0 ? `\n\nNote: ${heldBack} entries were held back by the workspace_dir filter.` : "";
      return { content: [{ type: "text", text: `Review-gate findings (newest first):\n\n${body}${note}` }] };
    }
  });
}
