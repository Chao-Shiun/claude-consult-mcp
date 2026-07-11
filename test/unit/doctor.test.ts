import { describe, expect, it } from "vitest";
import { runDoctor, type DoctorDeps } from "../../src/cli/doctor.js";
import { ENV, VERIFIED_CLAUDE_VERSION } from "../../src/constants.js";
import type { JournalEntry, JournalReadStats } from "../../src/journal.js";

const WORKSPACE = process.platform === "win32" ? "C:\\repo\\project" : "/repo/project";
const OTHER_WORKSPACE = process.platform === "win32" ? "C:\\repo\\other" : "/repo/other";
const JOURNAL_DIR = process.platform === "win32" ? "C:\\journal" : "/tmp/journal";
const SESSION_ID = "123e4567-e89b-12d3-a456-426614174000";

interface DepsOptions {
  platform?: string;
  nodeVersion?: string;
  claudeResult?: { exitCode: number | null; stdout: string; stderr: string } | Error;
  codexResult?: { exitCode: number | null; stdout: string; stderr: string } | Error;
  configText?: string | undefined;
  hooksText?: string | undefined;
  liveResult?: { ok: boolean; detail: string };
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  journalResult?: JournalReadStats | Error;
}

function journalEntry(workspaceDir: string, overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    ts: "2026-07-11T00:00:00.000Z",
    tool: "ask_claude",
    sessionId: SESSION_ID,
    workspaceDir,
    model: "haiku",
    excerpt: "PRIVATE JOURNAL CONTENT",
    costUsd: undefined,
    durationMs: undefined,
    ...overrides
  };
}

function makeDeps(options: DepsOptions = {}): { lines: string[]; liveCalls: number[]; journalReads: Array<{ dir: string; month: string; limit: number }>; deps: DoctorDeps } {
  const lines: string[] = [];
  const liveCalls: number[] = [];
  const journalReads: Array<{ dir: string; month: string; limit: number }> = [];
  const claudeResult = options.claudeResult ?? { exitCode: 0, stdout: "2.1.163 (Claude Code)", stderr: "" };
  const codexResult = options.codexResult ?? { exitCode: 0, stdout: "codex-cli 0.142.0", stderr: "" };
  return {
    lines,
    liveCalls,
    journalReads,
    deps: {
      platform: options.platform ?? "win32",
      nodeVersion: options.nodeVersion ?? "v24.13.0",
      env: options.env ?? {},
      cwd: options.cwd ?? WORKSPACE,
      currentMonth: "2026-07",
      readJournal: async (dir, month, limit) => {
        journalReads.push({ dir, month, limit });
        if (options.journalResult instanceof Error) {
          throw options.journalResult;
        }
        return options.journalResult ?? { entries: Object.freeze([]), skippedLines: 0 };
      },
      runCommand: async (command) => {
        const result = command === "claude" ? claudeResult : codexResult;
        if (result instanceof Error) {
          throw result;
        }
        return result;
      },
      readConfigToml: async () => options.configText,
      readHooksJson: async () => options.hooksText,
      liveProbe: async () => {
        liveCalls.push(1);
        return options.liveResult ?? { ok: true, detail: "claude answered" };
      },
      print: (line) => {
        lines.push(line);
      }
    }
  };
}

const REGISTERED_WIN = `[mcp_servers.claude-consult]\ncommand = "cmd"\nargs = ["/c", "npx", "-y", "claude-consult-mcp"]\n\n[other]\n`;
const REGISTERED_WIN_NO_CMD = `[mcp_servers.claude-consult]\ncommand = "npx"\nargs = ["-y", "claude-consult-mcp"]\n\n[other]\n`;
const HOOKS_WITHOUT_GATE = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node existing.js" }] }] } });
const HOOKS_WITH_GATE = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "npx -y claude-consult-mcp review-gate" }] }] } });
const HOOKS_WITH_GATE_AT_1_0 = JSON.stringify({ hooks: { Stop: [
  { hooks: [{ type: "command", command: "node existing.js" }] },
  { hooks: [{ type: "command", command: "npx -y claude-consult-mcp review-gate" }] }
] } });
const HOOKS_WITH_TWO_GATES = JSON.stringify({ hooks: { Stop: [{ hooks: [
  { type: "command", command: "npx -y claude-consult-mcp review-gate" },
  { type: "command", command: "cmd /c npx -y claude-consult-mcp review-gate" }
] }] } });
const TRUSTED_0_0 = `${REGISTERED_WIN}[hooks.state.'/home/me/.codex/hooks.json:stop:0:0']\ntrusted_hash = "abc123"\n`;
const TRUSTED_0_1 = `${REGISTERED_WIN}[hooks.state.'/home/me/.codex/hooks.json:stop:0:1']\ntrusted_hash = "abc123"\n`;
const TRUSTED_1_0 = `${REGISTERED_WIN}[hooks.state.'/home/me/.codex/hooks.json:stop:1:0']\ntrusted_hash = "abc123"\n`;
const UNTRUSTED_WITH_DISTANT_HASH = `${REGISTERED_WIN}[hooks.state.'/home/me/.codex/hooks.json:stop:0:0']\nfoo = "bar"\n# 1\n# 2\n# 3\n# 4\n# 5\n# 6\ntrusted_hash = "too-far"\n`;

describe("runDoctor", () => {
  it("prints exactly one content-free continuity line for every diagnostic state", async () => {
    const cases: ReadonlyArray<{ options: DepsOptions; expected: string; reads: number }> = [
      {
        options: {},
        expected: `[ok] continuity inactive: ${ENV.journalDir} is not set`,
        reads: 0
      },
      {
        options: { env: { [ENV.journalDir]: "relative/journal" } },
        expected: `[warn] continuity inactive: ${ENV.journalDir} is not a local absolute path`,
        reads: 0
      },
      {
        options: { env: { [ENV.journalDir]: JOURNAL_DIR, [ENV.continuity]: "0" } },
        expected: `[ok] continuity disabled by ${ENV.continuity}=0`,
        reads: 0
      },
      {
        options: { env: { [ENV.journalDir]: JOURNAL_DIR }, journalResult: new Error("PRIVATE read failure") },
        expected: "[warn] continuity: current-month journal unreadable",
        reads: 1
      },
      {
        options: {
          env: { [ENV.journalDir]: JOURNAL_DIR },
          journalResult: {
            entries: Object.freeze([
              journalEntry(WORKSPACE),
              journalEntry(OTHER_WORKSPACE, { sessionId: "123e4567-e89b-12d3-a456-426614174001" }),
              journalEntry(WORKSPACE, { sessionId: "not-a-uuid" })
            ]),
            skippedLines: 2
          }
        },
        expected: `[ok] continuity active: 1 of 3 current-month entries match workspace ${WORKSPACE} (2 invalid entries skipped)`,
        reads: 1
      },
      {
        options: {
          env: { [ENV.journalDir]: JOURNAL_DIR },
          journalResult: { entries: Object.freeze([journalEntry(OTHER_WORKSPACE)]), skippedLines: 1 }
        },
        expected: `[ok] continuity active: 0 of 1 current-month entries match workspace ${WORKSPACE} (no digest here yet) (1 invalid entries skipped)`,
        reads: 1
      }
    ];

    for (const testCase of cases) {
      const { lines, journalReads, deps } = makeDeps({ configText: REGISTERED_WIN, ...testCase.options });
      await expect(runDoctor([], deps)).resolves.toBe(0);
      expect(lines.filter((line) => line.includes("continuity"))).toEqual([testCase.expected]);
      expect(journalReads).toHaveLength(testCase.reads);
      expect(lines.join("\n")).not.toMatch(/PRIVATE JOURNAL CONTENT|PRIVATE read failure|123e4567|ask_claude|<recent-consultations>/);
    }
  });

  it("probes the current month in the doctor process workspace without changing an existing failure exit code", async () => {
    const { lines, journalReads, deps } = makeDeps({
      nodeVersion: "v18.19.0",
      configText: REGISTERED_WIN,
      env: { [ENV.journalDir]: JOURNAL_DIR },
      journalResult: { entries: Object.freeze([]), skippedLines: 0 }
    });

    expect(await runDoctor([], deps)).toBe(1);
    expect(journalReads).toEqual([{ dir: JOURNAL_DIR, month: "2026-07", limit: 20 }]);
    expect(lines.filter((line) => line.includes("continuity"))).toEqual([
      `[ok] continuity active: 0 of 0 current-month entries match workspace ${WORKSPACE} (no digest here yet)`
    ]);
  });

  it("reports all-ok on a healthy machine", async () => {
    const { lines, deps } = makeDeps({ configText: REGISTERED_WIN });
    const exitCode = await runDoctor([], deps);
    expect(exitCode).toBe(0);
    const output = lines.join("\n");
    expect(output).toContain("[ok] node v24.13.0");
    expect(output).toContain("[ok] claude 2.1.163");
    expect(output).not.toContain("[warn] claude version");
    expect(output).toContain("[ok] codex codex-cli 0.142.0");
    expect(output).toContain("[ok] registered in ~/.codex/config.toml");
  });

  it("does not warn when the claude version matches the verified version", async () => {
    const { lines, deps } = makeDeps({ claudeResult: { exitCode: 0, stdout: `Claude Code ${VERIFIED_CLAUDE_VERSION}`, stderr: "" }, configText: REGISTERED_WIN });
    const exitCode = await runDoctor([], deps);
    expect(exitCode).toBe(0);
    expect(lines.join("\n")).not.toContain("[warn] claude version");
  });

  it("warns without failing when the claude version differs from the verified version", async () => {
    const { lines, deps } = makeDeps({ claudeResult: { exitCode: 0, stdout: "Claude Code 2.2.0", stderr: "" }, configText: REGISTERED_WIN });
    const exitCode = await runDoctor([], deps);
    expect(exitCode).toBe(0);
    expect(lines).toContain(`[warn] claude version 2.2.0 differs from the verified ${VERIFIED_CLAUDE_VERSION}; if tools misbehave, check for envelope or flag changes in the newer CLI`);
  });

  it("warns with unknown without changing the exit code when the claude version is unparseable", async () => {
    const { lines, deps } = makeDeps({ claudeResult: { exitCode: 0, stdout: "Claude Code nightly", stderr: "" }, configText: REGISTERED_WIN });
    const exitCode = await runDoctor([], deps);
    expect(exitCode).toBe(0);
    expect(lines).toContain(`[warn] claude version unknown differs from the verified ${VERIFIED_CLAUDE_VERSION}; if tools misbehave, check for envelope or flag changes in the newer CLI`);
  });

  it("fails with an install hint when claude is missing", async () => {
    const { lines, deps } = makeDeps({ claudeResult: Object.assign(new Error("ENOENT"), { code: "ENOENT" }), configText: REGISTERED_WIN });
    const exitCode = await runDoctor([], deps);
    expect(exitCode).toBe(1);
    expect(lines.join("\n")).toContain("npm install -g @anthropic-ai/claude-code");
  });

  it("fails when codex is missing", async () => {
    const { lines, deps } = makeDeps({ codexResult: Object.assign(new Error("ENOENT"), { code: "ENOENT" }), configText: REGISTERED_WIN });
    const exitCode = await runDoctor([], deps);
    expect(exitCode).toBe(1);
    expect(lines.join("\n")).toContain("[fail] codex");
  });

  it("warns when the server is not registered yet", async () => {
    const { lines, deps } = makeDeps({ configText: "[mcp_servers.other]\n" });
    const exitCode = await runDoctor([], deps);
    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("[warn] not registered");
  });

  it("warns when a Windows registration is missing the cmd /c wrapper", async () => {
    const { lines, deps } = makeDeps({ configText: REGISTERED_WIN_NO_CMD });
    await runDoctor([], deps);
    expect(lines.join("\n")).toContain("cmd /c");
  });

  it("stays silent when hooks.json is absent or does not contain the review gate", async () => {
    const absent = makeDeps({ configText: REGISTERED_WIN });
    await runDoctor([], absent.deps);
    expect(absent.lines.join("\n")).not.toContain("review-gate hook");

    const withoutGate = makeDeps({ configText: REGISTERED_WIN, hooksText: HOOKS_WITHOUT_GATE });
    await runDoctor([], withoutGate.deps);
    expect(withoutGate.lines.join("\n")).not.toContain("review-gate hook");
  });

  it("warns without failing when hooks.json is invalid JSON", async () => {
    const { lines, deps } = makeDeps({ configText: REGISTERED_WIN, hooksText: "{ not json" });
    const exitCode = await runDoctor([], deps);
    expect(exitCode).toBe(0);
    expect(lines).toContain("[warn] ~/.codex/hooks.json is not valid JSON");
  });

  it("reports ok when a review-gate hook trust record exists", async () => {
    const { lines, deps } = makeDeps({ configText: TRUSTED_0_0, hooksText: HOOKS_WITH_GATE });
    const exitCode = await runDoctor([], deps);
    expect(exitCode).toBe(0);
    expect(lines).toContain("[ok] review-gate hook trust record found");
  });

  it("warns without changing the exit code when the review-gate hook is not trusted", async () => {
    const { lines, deps } = makeDeps({ configText: REGISTERED_WIN, hooksText: HOOKS_WITH_GATE });
    const exitCode = await runDoctor([], deps);
    expect(exitCode).toBe(0);
    expect(lines).toContain("[warn] review-gate hook installed but not trusted - run codex interactively once and approve the hook, or it will not fire");
  });

  it("finds trust records for non-zero hook slots and any matching duplicate slot", async () => {
    const nonZero = makeDeps({ configText: TRUSTED_1_0, hooksText: HOOKS_WITH_GATE_AT_1_0 });
    await runDoctor([], nonZero.deps);
    expect(nonZero.lines).toContain("[ok] review-gate hook trust record found");

    const duplicate = makeDeps({ configText: TRUSTED_0_1, hooksText: HOOKS_WITH_TWO_GATES });
    await runDoctor([], duplicate.deps);
    expect(duplicate.lines).toContain("[ok] review-gate hook trust record found");
  });

  it("warns when the trust key exists but trusted_hash is not nearby", async () => {
    const { lines, deps } = makeDeps({ configText: UNTRUSTED_WITH_DISTANT_HASH, hooksText: HOOKS_WITH_GATE });
    await runDoctor([], deps);
    expect(lines).toContain("[warn] review-gate hook installed but not trusted - run codex interactively once and approve the hook, or it will not fire");
  });

  it("fails on a Node version below 20", async () => {
    const { lines, deps } = makeDeps({ nodeVersion: "v18.19.0", configText: REGISTERED_WIN });
    const exitCode = await runDoctor([], deps);
    expect(exitCode).toBe(1);
    expect(lines.join("\n")).toContain("[fail] node");
  });

  it("runs the paid live probe only behind the --live flag", async () => {
    const first = makeDeps({ configText: REGISTERED_WIN });
    await runDoctor([], first.deps);
    expect(first.liveCalls).toHaveLength(0);
    const second = makeDeps({ configText: REGISTERED_WIN, liveResult: { ok: false, detail: "not authenticated" } });
    const exitCode = await runDoctor(["--live"], second.deps);
    expect(second.liveCalls).toHaveLength(1);
    expect(exitCode).toBe(1);
    expect(second.lines.join("\n")).toContain("not authenticated");
  });

  it("never prints a successful live probe's session id", async () => {
    const { lines, deps } = makeDeps({
      configText: REGISTERED_WIN,
      liveResult: { ok: true, detail: `claude answered (session ${SESSION_ID})` }
    });

    expect(await runDoctor(["--live"], deps)).toBe(0);
    expect(lines).toContain("[ok] live probe: claude answered");
    expect(lines.join("\n")).not.toContain(SESSION_ID);
  });
});
