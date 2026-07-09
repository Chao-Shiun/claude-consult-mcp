import { describe, expect, it } from "vitest";
import { ClaudeConsultError, ERROR_CODES } from "../../src/errors.js";
import type { ClaudeEnvelope } from "../../src/claude/parse-output.js";
import type { RunnerRequest } from "../../src/claude/runner.js";
import { runReviewGate, REVIEW_GATE_QUESTION, type ReviewGateDeps } from "../../src/cli/review-gate.js";

const CWD = process.platform === "win32" ? "C:\\repo-a" : "/repo-a";
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
  readonly stdout: string[];
  readonly stderr: string[];
}

interface DepsOptions {
  readonly diff?: string;
  readonly status?: string;
  readonly revParseExit?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly result?: ClaudeEnvelope;
  readonly runClaudeError?: unknown;
  readonly hookStdin?: string | undefined;
}

function makeDeps(options: DepsOptions = {}): { readonly deps: ReviewGateDeps; readonly recorded: Recorded } {
  const recorded: Recorded = { commands: [], createdModels: [], requests: [], stdout: [], stderr: [] };
  return {
    recorded,
    deps: {
      cwd: CWD,
      env: options.env ?? {},
      stdinIsTTY: options.hookStdin === undefined,
      readStdin: async () => options.hookStdin ?? "",
      runCommand: async (command, args, runOptions) => {
        recorded.commands.push({ command, args, cwd: runOptions?.cwd });
        if (args[0] === "rev-parse") {
          const exitCode = options.revParseExit ?? 0;
          return { exitCode, stdout: exitCode === 0 ? "true\n" : "", stderr: "" };
        }
        if (args[0] === "diff") {
          return { exitCode: 0, stdout: options.diff ?? "diff --git a/file.ts b/file.ts\n+change\n", stderr: "" };
        }
        if (args[0] === "status") {
          return { exitCode: 0, stdout: options.status ?? " M file.ts\n", stderr: "" };
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

  it("fails open for invalid arguments", async () => {
    const { deps, recorded } = makeDeps();

    await expect(runReviewGate(["--model"], deps)).resolves.toBe(0);

    expect(recorded.requests).toHaveLength(0);
    expect(recorded.stderr).toEqual(["review-gate: skipped (INVALID_INPUT)"]);
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
    expect(recorded.requests[0]?.origin).toEqual({ tool: "review-gate", excerpt: "automatic post-turn diff review" });
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

  it("prints valid Stop-hook JSON when invoked by a Codex stop hook", async () => {
    const { deps, recorded } = makeDeps({
      hookStdin: JSON.stringify({ hook_event_name: "Stop" }),
      result: { ...ENVELOPE, result: "- src/a.ts:1 has a bug" }
    });

    await expect(runReviewGate([], deps)).resolves.toBe(0);

    const payload = JSON.parse(recorded.stdout[0] ?? "{}") as { systemMessage?: string };
    expect(payload.systemMessage).toBe("claude-consult review-gate:\n- src/a.ts:1 has a bug");
  });

  it.each(ERROR_CODES)("fails open for Claude taxonomy error %s", async (code) => {
    const { deps, recorded } = makeDeps({
      runClaudeError: new ClaudeConsultError(code, "taxonomy failure", "test hint")
    });

    await expect(runReviewGate([], deps)).resolves.toBe(0);

    expect(recorded.stderr).toEqual([`review-gate: skipped (${code})`]);
  });
});
