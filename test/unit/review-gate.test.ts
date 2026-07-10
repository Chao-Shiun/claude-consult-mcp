import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ClaudeConsultError, ERROR_CODES } from "../../src/errors.js";
import type { ClaudeEnvelope } from "../../src/claude/parse-output.js";
import type { RunnerRequest } from "../../src/claude/runner.js";
import { resolveGateLogPath } from "../../src/gate-log.js";
import { createDefaultReviewGateDeps, runReviewGate, REVIEW_GATE_QUESTION, type ReviewGateDeps } from "../../src/cli/review-gate.js";

const CWD = process.platform === "win32" ? "C:\\repo-a" : "/repo-a";
const CWD_B = process.platform === "win32" ? "C:\\repo-b" : "/repo-b";
const GATE_LOG = process.platform === "win32" ? "C:\\logs\\review-gate.log" : "/logs/review-gate.log";
const JOURNAL_DIR = process.platform === "win32" ? "C:\\journal" : "/journal";
const RELATIVE_LOG = process.platform === "win32" ? "logs\\review-gate.log" : "logs/review-gate.log";
const UNC_LOG = process.platform === "win32" ? "\\\\server\\share\\review-gate.log" : "//server/share/review-gate.log";
const DEFAULT_DIFF = "diff --git a/file.ts b/file.ts\n+change\n";
const DEFAULT_STATUS = " M file.ts\n";
const NOW = "2026-07-09T03:20:11.000Z";
const ENVELOPE: ClaudeEnvelope = Object.freeze({
  result: "LGTM",
  structuredOutput: undefined,
  sessionId: "123e4567-e89b-12d3-a456-426614174000",
  isError: false,
  subtype: undefined,
  apiErrorStatus: undefined,
  totalCostUsd: 0.01,
  durationMs: 1000,
  numTurns: 1
});

interface Recorded {
  readonly commands: Array<{ readonly command: string; readonly args: readonly string[]; readonly cwd?: string | undefined }>;
  readonly createdModels: string[];
  readonly requests: RunnerRequest[];
  readonly findings: string[];
  memoReads: number;
  readonly memoWrites: string[];
  readonly stdout: string[];
  readonly stderr: string[];
}

interface DepsOptions {
  readonly diff?: string;
  readonly status?: string;
  readonly cwd?: string;
  readonly revParseExit?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly result?: ClaudeEnvelope;
  readonly runClaudeError?: unknown;
  readonly appendFindingsError?: unknown;
  readonly memo?: string | undefined;
  readonly memoEnabled?: boolean;
  readonly readMemoError?: unknown;
  readonly writeMemoError?: unknown;
}

interface CooldownMemoEntry {
  readonly hash: string;
  readonly at: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function reviewedContentHash(cwd: string, diff = DEFAULT_DIFF, status = DEFAULT_STATUS): string {
  return sha256(`${cwd}\0${diff}\0${status}`);
}

function memoFor(cwd: string, diff = DEFAULT_DIFF, status = DEFAULT_STATUS): string {
  return JSON.stringify({ [sha256(cwd)]: { hash: reviewedContentHash(cwd, diff, status), at: "2026-07-08T00:00:00.000Z" } });
}

function makeDeps(options: DepsOptions = {}): { readonly deps: ReviewGateDeps; readonly recorded: Recorded } {
  const recorded: Recorded = { commands: [], createdModels: [], requests: [], findings: [], memoReads: 0, memoWrites: [], stdout: [], stderr: [] };
  const memoEnabled = options.memoEnabled === true || options.memo !== undefined || options.readMemoError !== undefined || options.writeMemoError !== undefined;
  return {
    recorded,
    deps: {
      cwd: options.cwd ?? CWD,
      env: options.env ?? {},
      now: () => new Date(NOW),
      appendFindings: async (record) => {
        if (options.appendFindingsError !== undefined) {
          throw options.appendFindingsError;
        }
        recorded.findings.push(record);
      },
      readMemo: memoEnabled ? async () => {
        recorded.memoReads += 1;
        if (options.readMemoError !== undefined) {
          throw options.readMemoError;
        }
        return options.memo;
      } : undefined,
      writeMemo: memoEnabled ? async (content) => {
        if (options.writeMemoError !== undefined) {
          throw options.writeMemoError;
        }
        recorded.memoWrites.push(content);
      } : undefined,
      runCommand: async (command, args, runOptions) => {
        recorded.commands.push({ command, args, cwd: runOptions?.cwd });
        if (args[0] === "rev-parse") {
          const exitCode = options.revParseExit ?? 0;
          return { exitCode, stdout: exitCode === 0 ? "true\n" : "", stderr: "" };
        }
        if (args[0] === "diff") {
          return { exitCode: 0, stdout: options.diff ?? DEFAULT_DIFF, stderr: "" };
        }
        if (args[0] === "status") {
          return { exitCode: 0, stdout: options.status ?? DEFAULT_STATUS, stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "unexpected git command" };
      },
      createRunner: (model) => {
        recorded.createdModels.push(model);
        return async (request) => {
          recorded.requests.push(request);
          if (options.runClaudeError !== undefined) {
            throw options.runClaudeError;
          }
          return options.result ?? ENVELOPE;
        };
      },
      print: (line) => {
        recorded.stdout.push(line);
      },
      printErr: (line) => {
        recorded.stderr.push(line);
      }
    }
  };
}

describe("review-gate CLI", () => {
  it("starts the default stdin read at deps creation", async () => {
    const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
    Object.defineProperty(stdin, "isTTY", { value: undefined });
    const deps = createDefaultReviewGateDeps(() => undefined, () => undefined, stdin);

    expect(stdin.listenerCount("data")).toBeGreaterThan(0);
    stdin.end(JSON.stringify({ hook_event_name: "Stop", cwd: process.cwd(), last_assistant_message: "implemented validation" }));

    await expect(deps.readHookClaim?.()).resolves.toBe("implemented validation");
  });

  it("awaits the hook claim once before the first git call", async () => {
    const order: string[] = [];
    let reads = 0;
    const base = makeDeps();
    const deps: ReviewGateDeps = {
      ...base.deps,
      readHookClaim: async () => {
        reads += 1;
        order.push("claim");
        return "implemented validation";
      },
      runCommand: async (...args) => {
        order.push("git");
        return base.deps.runCommand(...args);
      }
    };

    await expect(runReviewGate([], deps)).resolves.toBe(0);

    expect(reads).toBe(1);
    expect(order[0]).toBe("claim");
  });

  it("degrades a rejected hook claim read to the diff-only review", async () => {
    const base = makeDeps();
    const deps: ReviewGateDeps = { ...base.deps, readHookClaim: async () => Promise.reject(new Error("stdin failed")) };

    await expect(runReviewGate([], deps)).resolves.toBe(0);

    expect(base.recorded.requests).toHaveLength(1);
  });

  it("fails open silently outside a git repository", async () => {
    const { deps, recorded } = makeDeps({ revParseExit: 128 });

    await expect(runReviewGate([], deps)).resolves.toBe(0);

    expect(recorded.requests).toHaveLength(0);
    expect(recorded.stdout).toEqual([]);
    expect(recorded.stderr).toEqual([]);
  });

  it("fails open silently for an empty diff and clean status", async () => {
    const { deps, recorded } = makeDeps({ diff: "", status: "" });

    await expect(runReviewGate([], deps)).resolves.toBe(0);

    expect(recorded.requests).toHaveLength(0);
    expect(recorded.stdout).toEqual([]);
    expect(recorded.stderr).toEqual([]);
  });

  it("uses hardened git diff flags", async () => {
    const { deps, recorded } = makeDeps();

    await runReviewGate([], deps);

    expect(recorded.commands.find((command) => command.args[0] === "diff")).toEqual({
      command: "git",
      args: ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "HEAD"],
      cwd: CWD
    });
    expect(recorded.commands.find((command) => command.args[0] === "status")?.args).toEqual(["status", "--porcelain"]);
  });

  it("skips oversized diffs with a stderr note and exit 0", async () => {
    const { deps, recorded } = makeDeps({ diff: "abcd" });

    await expect(runReviewGate(["--max-diff-bytes", "3"], deps)).resolves.toBe(0);

    expect(recorded.requests).toHaveLength(0);
    expect(recorded.stderr).toEqual(["review-gate: diff too large (4 bytes), skipped"]);
  });

  it("skips an unchanged diff without invoking Claude", async () => {
    const { deps, recorded } = makeDeps({ memo: memoFor(CWD) });

    await expect(runReviewGate([], deps)).resolves.toBe(0);

    expect(recorded.requests).toHaveLength(0);
    expect(recorded.memoReads).toBe(1);
    expect(recorded.memoWrites).toEqual([]);
    expect(recorded.stderr).toEqual(["review-gate: diff unchanged since last review, skipped"]);
  });

  it("reviews a changed diff and upserts the repository memo", async () => {
    const { deps, recorded } = makeDeps({ memo: memoFor(CWD, "old diff", DEFAULT_STATUS) });

    await expect(runReviewGate([], deps)).resolves.toBe(0);

    expect(recorded.requests).toHaveLength(1);
    expect(recorded.memoWrites).toHaveLength(1);
    const memo = JSON.parse(recorded.memoWrites[0] ?? "") as Record<string, CooldownMemoEntry>;
    expect(memo[sha256(CWD)]).toEqual({ hash: reviewedContentHash(CWD), at: NOW });
  });

  it("forces a review despite a matching memo and still updates it", async () => {
    const { deps, recorded } = makeDeps({ memo: memoFor(CWD) });

    await expect(runReviewGate(["--force"], deps)).resolves.toBe(0);

    expect(recorded.requests).toHaveLength(1);
    expect(recorded.memoWrites).toHaveLength(1);
    expect(recorded.stderr).toEqual([]);
  });

  it("does not read or write a memo when no log path is resolved", async () => {
    const { deps, recorded } = makeDeps();

    await expect(runReviewGate([], deps)).resolves.toBe(0);

    expect(recorded.requests).toHaveLength(1);
    expect(recorded.memoReads).toBe(0);
    expect(recorded.memoWrites).toEqual([]);
  });

  it("reviews and rewrites the memo after corrupt JSON", async () => {
    const { deps, recorded } = makeDeps({ memo: "{" });

    await expect(runReviewGate([], deps)).resolves.toBe(0);

    expect(recorded.requests).toHaveLength(1);
    expect(recorded.memoWrites).toHaveLength(1);
    expect(() => JSON.parse(recorded.memoWrites[0] ?? "")).not.toThrow();
  });

  it("leaves the memo untouched when the Claude review fails", async () => {
    const { deps, recorded } = makeDeps({ memo: "{}", runClaudeError: new Error("failed") });

    await expect(runReviewGate([], deps)).resolves.toBe(0);

    expect(recorded.memoWrites).toEqual([]);
  });

  it("keeps only the newest 20 repository entries", async () => {
    const entries = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
      sha256(`repo-${index}`),
      { hash: sha256(`content-${index}`), at: new Date(Date.UTC(2026, 5, index + 1)).toISOString() }
    ]));
    const oldestKey = sha256("repo-0");
    const { deps, recorded } = makeDeps({ memo: JSON.stringify(entries) });

    await expect(runReviewGate([], deps)).resolves.toBe(0);

    expect(recorded.memoWrites).toHaveLength(1);
    const memo = JSON.parse(recorded.memoWrites[0] ?? "") as Record<string, CooldownMemoEntry>;
    expect(Object.keys(memo)).toHaveLength(20);
    expect(memo[oldestKey]).toBeUndefined();
    expect(memo[sha256(CWD)]).toEqual({ hash: reviewedContentHash(CWD), at: NOW });
  });

  it("isolates cooldown entries by repository", async () => {
    const { deps, recorded } = makeDeps({ cwd: CWD_B, memo: memoFor(CWD) });

    await expect(runReviewGate([], deps)).resolves.toBe(0);

    expect(recorded.requests).toHaveLength(1);
    expect(recorded.memoWrites).toHaveLength(1);
    const memo = JSON.parse(recorded.memoWrites[0] ?? "") as Record<string, CooldownMemoEntry>;
    expect(memo[sha256(CWD)]).toBeDefined();
    expect(memo[sha256(CWD_B)]).toEqual({ hash: reviewedContentHash(CWD_B), at: NOW });
  });

  it("fails open when reading the cooldown memo fails", async () => {
    const { deps, recorded } = makeDeps({ memoEnabled: true, readMemoError: new Error("read failed") });

    await expect(runReviewGate([], deps)).resolves.toBe(0);

    expect(recorded.requests).toHaveLength(1);
    expect(recorded.memoWrites).toHaveLength(1);
  });

  it("fails open with the exact note when writing the cooldown memo fails", async () => {
    const { deps, recorded } = makeDeps({ memoEnabled: true, writeMemoError: new Error("write failed") });

    await expect(runReviewGate([], deps)).resolves.toBe(0);

    expect(recorded.stdout).toEqual(["claude-consult review-gate:\nLGTM"]);
    expect(recorded.stderr).toEqual(["review-gate: cooldown memo unavailable"]);
  });

  it("includes --force in the runtime unknown-flag message", async () => {
    const { deps, recorded } = makeDeps();

    await expect(runReviewGate(["--unknown"], deps)).resolves.toBe(0);

    expect(recorded.requests).toHaveLength(0);
    expect(recorded.stderr).toEqual(["review-gate: skipped (INVALID_INPUT: unknown flag --unknown; valid flags: --model, --max-diff-bytes, --quiet, --force)"]);
  });

  it("fails open for invalid arguments", async () => {
    const { deps, recorded } = makeDeps();

    await expect(runReviewGate(["--model"], deps)).resolves.toBe(0);

    expect(recorded.requests).toHaveLength(0);
    expect(recorded.stderr).toEqual(["review-gate: skipped (INVALID_INPUT: missing value for --model)"]);
  });

  it("resolves the gate model from flag, env, then haiku", async () => {
    const first = makeDeps({ env: { CLAUDE_CONSULT_GATE_MODEL: "sonnet" } });
    await runReviewGate(["--model", "opus"], first.deps);
    expect(first.recorded.createdModels).toEqual(["opus"]);
    expect(first.recorded.requests[0]?.model).toBe("opus");

    const second = makeDeps({ env: { CLAUDE_CONSULT_GATE_MODEL: "sonnet" } });
    await runReviewGate([], second.deps);
    expect(second.recorded.createdModels).toEqual(["sonnet"]);

    const third = makeDeps();
    await runReviewGate([], third.deps);
    expect(third.recorded.createdModels).toEqual(["haiku"]);
  });

  it("runs Claude with the automatic review question and journal origin", async () => {
    const { deps, recorded } = makeDeps();

    await runReviewGate([], deps);

    expect(recorded.requests[0]?.prompt).toContain(REVIEW_GATE_QUESTION);
    expect(recorded.requests[0]?.prompt).toContain("<git-status>");
    expect(recorded.requests[0]?.prompt).toContain("<diff>");
    expect(recorded.requests[0]?.appendSystemPrompt).toContain("strictly advisory");
    expect(recorded.requests[0]?.addDirs).toEqual([CWD]);
    expect(recorded.requests[0]?.cwd).toBe(CWD);
    expect(recorded.requests[0]?.origin).toEqual({ tool: "review-gate", excerpt: "automatic post-turn diff review", excerptFromResult: true });
  });

  it("suppresses LGTM output in quiet mode", async () => {
    const { deps, recorded } = makeDeps({ result: { ...ENVELOPE, result: "LGTM" } });

    await expect(runReviewGate(["--quiet"], deps)).resolves.toBe(0);

    expect(recorded.stdout).toEqual([]);
  });

  it("prints problem output with the review-gate heading", async () => {
    const { deps, recorded } = makeDeps({ result: { ...ENVELOPE, result: "- src/a.ts:1 has a bug" } });

    await expect(runReviewGate([], deps)).resolves.toBe(0);

    expect(recorded.stdout).toEqual(["claude-consult review-gate:\n- src/a.ts:1 has a bug"]);
  });

  it("prints problem output in quiet mode", async () => {
    const { deps, recorded } = makeDeps({ result: { ...ENVELOPE, result: "- src/a.ts:1 has a bug" } });

    await expect(runReviewGate(["--quiet"], deps)).resolves.toBe(0);

    expect(recorded.stdout).toEqual(["claude-consult review-gate:\n- src/a.ts:1 has a bug"]);
  });

  it("appends durable findings with timestamp, model, session id, repo, and answer", async () => {
    const { deps, recorded } = makeDeps({ result: { ...ENVELOPE, result: "- src/a.ts:1 has a bug" } });

    await expect(runReviewGate([], deps)).resolves.toBe(0);

    expect(recorded.findings).toEqual([`## 2026-07-09T03:20:11.000Z | model: haiku | session_id: ${ENVELOPE.sessionId} | repo: ${CWD}
- src/a.ts:1 has a bug

`]);
  });

  it("fails open when appending durable findings fails", async () => {
    const { deps, recorded } = makeDeps({
      result: { ...ENVELOPE, result: "- src/a.ts:1 has a bug" },
      appendFindingsError: new Error("disk full")
    });

    await expect(runReviewGate([], deps)).resolves.toBe(0);

    expect(recorded.stdout).toEqual(["claude-consult review-gate:\n- src/a.ts:1 has a bug"]);
    expect(recorded.stderr).toEqual(["review-gate: findings log unavailable"]);
  });

  it("resolves the findings log path from gate log, journal dir, or no log", () => {
    const stderr: string[] = [];
    expect(resolveGateLogPath({ CLAUDE_CONSULT_GATE_LOG: GATE_LOG }, (line) => stderr.push(line))).toBe(GATE_LOG);
    expect(resolveGateLogPath({ CLAUDE_CONSULT_JOURNAL_DIR: JOURNAL_DIR }, (line) => stderr.push(line))).toBe(`${JOURNAL_DIR}${process.platform === "win32" ? "\\" : "/"}review-gate.log`);
    expect(resolveGateLogPath({}, (line) => stderr.push(line))).toBeUndefined();
    expect(stderr).toEqual([]);
  });

  it("disables the findings log for invalid paths", () => {
    const stderr: string[] = [];
    expect(resolveGateLogPath({ CLAUDE_CONSULT_GATE_LOG: RELATIVE_LOG }, (line) => stderr.push(line))).toBeUndefined();
    expect(resolveGateLogPath({ CLAUDE_CONSULT_JOURNAL_DIR: UNC_LOG }, (line) => stderr.push(line))).toBeUndefined();
    expect(stderr).toEqual([
      "review-gate: findings log disabled (invalid CLAUDE_CONSULT_GATE_LOG)",
      "review-gate: findings log disabled (invalid CLAUDE_CONSULT_JOURNAL_DIR)"
    ]);
  });

  it.each(ERROR_CODES)("fails open for Claude taxonomy error %s", async (code) => {
    const { deps, recorded } = makeDeps({
      runClaudeError: new ClaudeConsultError(code, "taxonomy failure", "test hint")
    });

    await expect(runReviewGate([], deps)).resolves.toBe(0);

    expect(recorded.stderr).toEqual([`review-gate: skipped (${code})`]);
  });
});
