import { describe, expect, it } from "vitest";
import { runDoctor, type DoctorDeps } from "../../src/cli/doctor.js";
import { VERIFIED_CLAUDE_VERSION } from "../../src/constants.js";

interface DepsOptions {
  platform?: string;
  nodeVersion?: string;
  claudeResult?: { exitCode: number | null; stdout: string; stderr: string } | Error;
  codexResult?: { exitCode: number | null; stdout: string; stderr: string } | Error;
  configText?: string | undefined;
  liveResult?: { ok: boolean; detail: string };
}

function makeDeps(options: DepsOptions = {}): { lines: string[]; liveCalls: number[]; deps: DoctorDeps } {
  const lines: string[] = [];
  const liveCalls: number[] = [];
  const claudeResult = options.claudeResult ?? { exitCode: 0, stdout: "2.1.163 (Claude Code)", stderr: "" };
  const codexResult = options.codexResult ?? { exitCode: 0, stdout: "codex-cli 0.142.0", stderr: "" };
  return {
    lines,
    liveCalls,
    deps: {
      platform: options.platform ?? "win32",
      nodeVersion: options.nodeVersion ?? "v24.13.0",
      runCommand: async (command) => {
        const result = command === "claude" ? claudeResult : codexResult;
        if (result instanceof Error) {
          throw result;
        }
        return result;
      },
      readConfigToml: async () => options.configText,
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

describe("runDoctor", () => {
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
});
