import { describe, expect, it } from "vitest";
import { runSetup, type SetupDeps } from "../../src/cli/setup.js";

interface Recorded {
  commands: Array<{ command: string; args: readonly string[] }>;
  lines: string[];
}

function makeDeps(platform: string, result: { exitCode: number | null; stdout: string; stderr: string } | Error = { exitCode: 0, stdout: "", stderr: "" }): { recorded: Recorded; deps: SetupDeps } {
  const recorded: Recorded = { commands: [], lines: [] };
  return {
    recorded,
    deps: {
      platform,
      runCommand: async (command, args) => {
        recorded.commands.push({ command, args });
        if (result instanceof Error) {
          throw result;
        }
        return result;
      },
      print: (line) => {
        recorded.lines.push(line);
      }
    }
  };
}

describe("runSetup", () => {
  it("registers with the cmd /c npx wrapper on Windows", async () => {
    const { recorded, deps } = makeDeps("win32");
    const exitCode = await runSetup([], deps);
    expect(exitCode).toBe(0);
    expect(recorded.commands).toEqual([{
      command: "codex",
      args: ["mcp", "add", "claude-consult", "--", "cmd", "/c", "npx", "-y", "claude-consult-mcp"]
    }]);
  });

  it("registers with plain npx on macOS", async () => {
    const { recorded, deps } = makeDeps("darwin");
    await runSetup([], deps);
    expect(recorded.commands[0]?.args).toEqual(["mcp", "add", "claude-consult", "--", "npx", "-y", "claude-consult-mcp"]);
  });

  it("bakes policy options into the registration as env pairs", async () => {
    const { recorded, deps } = makeDeps("darwin");
    await runSetup(["--model", "sonnet", "--capability", "readonly", "--allowed-models", "sonnet,haiku", "--max-budget-usd", "1"], deps);
    expect(recorded.commands[0]?.args).toEqual([
      "mcp", "add", "claude-consult",
      "--env", "CLAUDE_CONSULT_MODEL=sonnet",
      "--env", "CLAUDE_CONSULT_CAPABILITY=readonly",
      "--env", "CLAUDE_CONSULT_ALLOWED_MODELS=sonnet,haiku",
      "--env", "CLAUDE_CONSULT_MAX_BUDGET_USD=1",
      "--", "npx", "-y", "claude-consult-mcp"
    ]);
  });

  it("prints the timeout TOML snippet and desktop restart note on success", async () => {
    const { recorded, deps } = makeDeps("win32");
    await runSetup([], deps);
    const output = recorded.lines.join("\n");
    expect(output).toContain("[mcp_servers.claude-consult]");
    expect(output).toContain("startup_timeout_sec = 60");
    expect(output).toContain("tool_timeout_sec = 600");
    expect(output).toContain("Restart the Codex desktop app");
  });

  it("suggests codex mcp remove when the server already exists", async () => {
    const { recorded, deps } = makeDeps("win32", { exitCode: 1, stdout: "", stderr: "error: an MCP server named claude-consult already exists" });
    const exitCode = await runSetup([], deps);
    expect(exitCode).toBe(1);
    expect(recorded.lines.join("\n")).toContain("codex mcp remove claude-consult");
  });

  it("explains how to install codex when the CLI is missing", async () => {
    const { recorded, deps } = makeDeps("win32", Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }));
    const exitCode = await runSetup([], deps);
    expect(exitCode).toBe(1);
    expect(recorded.lines.join("\n")).toContain("npm install -g @openai/codex");
  });

  it("rejects invalid option values and unknown flags", async () => {
    const { deps } = makeDeps("win32");
    await expect(runSetup(["--capability", "write"], deps)).resolves.toBe(1);
    await expect(runSetup(["--model", "--bad"], deps)).resolves.toBe(1);
    await expect(runSetup(["--unknown-flag", "x"], deps)).resolves.toBe(1);
    await expect(runSetup(["--max-budget-usd", "zero"], deps)).resolves.toBe(1);
  });
});
