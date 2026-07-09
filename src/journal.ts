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

export interface Journal {
  readonly append: (entry: JournalEntry) => Promise<void>;
  readonly read: (filter?: { readonly workspaceDir?: string; readonly limit?: number }) => Promise<readonly JournalEntry[]>;
}

function monthFileName(date: Date): string {
  return `consult-journal-${date.toISOString().slice(0, 7)}.jsonl`;
}

function clampLimit(limit: number | undefined): number {
  return Math.min(100, Math.max(1, limit ?? 20));
}

function freezeEntry(entry: JournalEntry): JournalEntry {
  return Object.freeze({ ...entry, excerpt: normalizeExcerpt(entry.excerpt) });
}

function isJournalFile(name: string): boolean {
  return /^consult-journal-\d{4}-\d{2}\.jsonl$/.test(name);
}

export function createJournal(dir: string, logger: Logger, now: () => Date = () => new Date()): Journal {
  const append = async (entry: JournalEntry): Promise<void> => {
    try {
      await mkdir(dir, { recursive: true });
      await appendFile(path.join(dir, monthFileName(now())), `${JSON.stringify(freezeEntry(entry))}\n`, "utf8");
    } catch (error) {
      logger.error(`failed to append consultation journal: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const read = async (filter?: { readonly workspaceDir?: string; readonly limit?: number }): Promise<readonly JournalEntry[]> => {
    const limit = clampLimit(filter?.limit);
    let names: string[];
    try {
      names = (await readdir(dir)).filter(isJournalFile).sort().reverse();
    } catch {
      return Object.freeze([]);
    }

    const entries: JournalEntry[] = [];
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
          const entry = freezeEntry(JSON.parse(line) as JournalEntry);
          if (filter?.workspaceDir === undefined || entry.workspaceDir === filter.workspaceDir) {
            entries.push(entry);
          }
        } catch (error) {
          logger.debug(`skipping corrupt journal line in ${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return Object.freeze(entries.sort((left, right) => right.ts.localeCompare(left.ts)).slice(0, limit));
  };

  return Object.freeze({ append, read });
}
