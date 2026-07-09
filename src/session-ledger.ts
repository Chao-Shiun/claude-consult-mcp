export interface SessionRecordInput {
  readonly sessionId: string;
  readonly tool: string;
  readonly workspaceDir: string | undefined;
  readonly model: string | undefined;
  readonly excerpt: string;
}

export interface SessionEntry extends SessionRecordInput {
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly turns: number;
}

export interface SessionLedger {
  readonly record: (input: SessionRecordInput) => void;
  readonly list: (filter?: { readonly workspaceDir?: string; readonly limit?: number }) => readonly SessionEntry[];
}

const EXCERPT_CHARS = 120;

function normalizeExcerpt(excerpt: string): string {
  return excerpt.replace(/\s+/g, " ").trim().slice(0, EXCERPT_CHARS);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 10;
  }
  return Math.min(50, Math.max(1, limit));
}

export function createSessionLedger(maxEntries = 50, now: () => Date = () => new Date()): SessionLedger {
  const entries = new Map<string, SessionEntry>();

  const evictOldest = (): void => {
    while (entries.size > maxEntries) {
      let oldest: SessionEntry | undefined;
      for (const entry of entries.values()) {
        if (oldest === undefined || entry.lastUsedAt < oldest.lastUsedAt) {
          oldest = entry;
        }
      }
      if (oldest === undefined) {
        return;
      }
      entries.delete(oldest.sessionId);
    }
  };

  const record = (input: SessionRecordInput): void => {
    const existing = entries.get(input.sessionId);
    const timestamp = now().toISOString();
    const entry = existing === undefined
      ? Object.freeze({ ...input, excerpt: normalizeExcerpt(input.excerpt), createdAt: timestamp, lastUsedAt: timestamp, turns: 1 })
      : Object.freeze({ ...existing, lastUsedAt: timestamp, turns: existing.turns + 1 });
    entries.set(input.sessionId, entry);
    evictOldest();
  };

  const list = (filter?: { readonly workspaceDir?: string; readonly limit?: number }): readonly SessionEntry[] => {
    const limit = clampLimit(filter?.limit);
    const matching = [...entries.values()]
      .filter((entry) => filter?.workspaceDir === undefined || entry.workspaceDir === filter.workspaceDir)
      .sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt))
      .slice(0, limit);
    return Object.freeze(matching);
  };

  return Object.freeze({ record, list });
}
