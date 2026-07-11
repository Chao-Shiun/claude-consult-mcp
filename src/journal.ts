import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "./logger.js";
import { normalizeExcerpt } from "./session-ledger.js";

export interface JournalEntry {
  readonly ts: string;
  readonly tool: string;
  readonly sessionId: string;
  readonly workspaceDir: string | undefined;
  readonly model: string | undefined;
  readonly excerpt: string;
  readonly costUsd: number | undefined;
  readonly durationMs: number | undefined;
}

export interface JournalReadStats {
  readonly entries: readonly JournalEntry[];
  readonly skippedLines: number;
}

interface JournalReadFilter {
  readonly workspaceDir?: string;
  readonly limit?: number;
  readonly month?: string;
}

export interface Journal {
  readonly append: (entry: JournalEntry) => Promise<void>;
  readonly read: (filter?: JournalReadFilter) => Promise<readonly JournalEntry[]>;
  readonly readWithStats?: (filter?: JournalReadFilter) => Promise<JournalReadStats>;
}

export interface JournalWithStats extends Journal {
  readonly readWithStats: (filter?: JournalReadFilter) => Promise<JournalReadStats>;
}

function monthFileName(date: Date): string {
  return `consult-journal-${date.toISOString().slice(0, 7)}.jsonl`;
}

function clampLimit(limit: number | undefined): number {
  return Math.min(100, Math.max(1, limit ?? 20));
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function freezeEntry(entry: JournalEntry): JournalEntry {
  return Object.freeze({
    ...entry,
    excerpt: normalizeExcerpt(entry.excerpt),
    costUsd: normalizeOptionalNumber(entry.costUsd),
    durationMs: normalizeOptionalNumber(entry.durationMs)
  });
}

export function isJournalEntry(value: unknown): value is JournalEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return typeof entry.ts === "string"
    && typeof entry.tool === "string"
    && typeof entry.sessionId === "string"
    && isOptionalString(entry.workspaceDir)
    && isOptionalString(entry.model)
    && typeof entry.excerpt === "string";
}

function isJournalFile(name: string): boolean {
  return /^consult-journal-\d{4}-\d{2}\.jsonl$/.test(name);
}

export function createJournal(dir: string, logger: Logger, now: () => Date = () => new Date()): JournalWithStats {
  const append = async (entry: JournalEntry): Promise<void> => {
    try {
      await mkdir(dir, { recursive: true });
      await appendFile(path.join(dir, monthFileName(now())), `${JSON.stringify(freezeEntry(entry))}\n`, "utf8");
    } catch (error) {
      logger.error(`failed to append consultation journal: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const collect = async (filter: JournalReadFilter | undefined, limit: number, swallowDirectoryError: boolean): Promise<JournalReadStats> => {
    let names: string[];
    try {
      names = (await readdir(dir))
        .filter((name) => isJournalFile(name) && (filter?.month === undefined || name === `consult-journal-${filter.month}.jsonl`))
        .sort()
        .reverse();
    } catch (error) {
      if (!swallowDirectoryError) {
        throw error;
      }
      return Object.freeze({ entries: Object.freeze([]), skippedLines: 0 });
    }

    const entries: JournalEntry[] = [];
    let skippedLines = 0;
    for (const name of names) {
      if (entries.length >= limit) {
        break;
      }
      const text = await readFile(path.join(dir, name), "utf8");
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() === "") {
          continue;
        }
        try {
          const parsed: unknown = JSON.parse(line);
          if (!isJournalEntry(parsed)) {
            throw new TypeError("invalid journal entry shape");
          }
          const entry = freezeEntry(parsed);
          if (filter?.workspaceDir === undefined || entry.workspaceDir === filter.workspaceDir) {
            entries.push(entry);
          }
        } catch {
          skippedLines += 1;
          logger.debug(`skipping corrupt journal line in ${name}`);
        }
      }
    }
    return Object.freeze({
      entries: Object.freeze(entries.sort((left, right) => right.ts.localeCompare(left.ts)).slice(0, limit)),
      skippedLines
    });
  };

  const read = async (filter?: JournalReadFilter): Promise<readonly JournalEntry[]> => {
    return (await collect(filter, clampLimit(filter?.limit), true)).entries;
  };

  const readWithStats = async (filter?: JournalReadFilter): Promise<JournalReadStats> => {
    return collect(filter, clampLimit(filter?.limit), false);
  };

  return Object.freeze({ append, read, readWithStats });
}
