import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
      },
      now: () => new Date("2026-07-09T12:34:56.000Z")
    }
  };
}

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "claude-consult-setup-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

function makeFileDeps(platform: string, homeDir: string): { recorded: Recorded; deps: SetupDeps } {
  const made = makeDeps(platform);
  return {
    recorded: made.recorded,
    deps: { ...made.deps, homeDir }
  };
}

async function readHooks(homeDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(homeDir, ".codex", "hooks.json"), "utf8")) as Record<string, unknown>;
}

function countReviewGateCommands(value: unknown): number {
  return JSON.stringify(value).match(/claude-consult-mcp review-gate/g)?.length ?? 0;
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

  it("installs the review gate as a Windows Codex Stop hook", async () => {
    await withTempHome(async (homeDir) => {
      const { recorded, deps } = makeFileDeps("win32", homeDir);

      await expect(runSetup(["--install-review-gate"], deps)).resolves.toBe(0);

      expect(await readHooks(homeDir)).toEqual({
        hooks: {
          Stop: [{
            matcher: "",
            hooks: [{
              type: "command",
              command: "cmd /c npx -y claude-consult-mcp review-gate"
            }]
          }]
        }
      });
      expect(recorded.lines).toEqual(["Installed the review gate as a Codex stop hook. Codex will ask you to trust the new hook on first use; the gate reviews uncommitted changes after each turn and stays silent when everything looks sound. Remove it anytime with: npx -y claude-consult-mcp setup --remove-review-gate"]);
      expect(recorded.commands).toEqual([]);
    });
  });

  it("installs the review gate with a plain npx launcher outside Windows", async () => {
    await withTempHome(async (homeDir) => {
      const { deps } = makeFileDeps("linux", homeDir);

      await runSetup(["--install-review-gate"], deps);

      expect(JSON.stringify(await readHooks(homeDir))).toContain("npx -y claude-consult-mcp review-gate");
      expect(JSON.stringify(await readHooks(homeDir))).not.toContain("cmd /c");
    });
  });

  it("is idempotent and preserves unrelated hook entries", async () => {
    await withTempHome(async (homeDir) => {
      const codexDir = path.join(homeDir, ".codex");
      await mkdir(codexDir, { recursive: true });
      await writeFile(path.join(codexDir, "hooks.json"), JSON.stringify({
        hooks: {
          PreToolUse: [{
            matcher: "Bash",
            hooks: [{ type: "command", command: "node existing.js" }]
          }],
          Stop: [{
            matcher: "",
            hooks: [{ type: "command", command: "old claude-consult-mcp review-gate" }]
          }]
        }
      }), "utf8");
      const { deps } = makeFileDeps("win32", homeDir);

      await runSetup(["--install-review-gate"], deps);
      await runSetup(["--install-review-gate"], deps);
      const hooks = await readHooks(homeDir);

      expect(countReviewGateCommands(hooks)).toBe(1);
      expect(JSON.stringify(hooks)).toContain("node existing.js");
      const backups = await readdir(codexDir);
      expect(backups.filter((name) => name === "hooks.json.bak-20260709123456")).toHaveLength(1);
    });
  });

  it("removes exactly the review gate hook", async () => {
    await withTempHome(async (homeDir) => {
      const { deps } = makeFileDeps("win32", homeDir);
      await runSetup(["--install-review-gate"], deps);

      await expect(runSetup(["--remove-review-gate"], deps)).resolves.toBe(0);

      expect(countReviewGateCommands(await readHooks(homeDir))).toBe(0);
    });
  });

  it("refuses to overwrite malformed hooks JSON", async () => {
    await withTempHome(async (homeDir) => {
      const codexDir = path.join(homeDir, ".codex");
      await mkdir(codexDir, { recursive: true });
      const hooksPath = path.join(codexDir, "hooks.json");
      await writeFile(hooksPath, "{ not json", "utf8");
      const { recorded, deps } = makeFileDeps("win32", homeDir);

      await expect(runSetup(["--install-review-gate"], deps)).resolves.toBe(1);

      expect(await readFile(hooksPath, "utf8")).toBe("{ not json");
      expect(recorded.lines.join("\n")).toContain("Cannot parse");
      expect(await readdir(codexDir)).toEqual(["hooks.json"]);
    });
  });

  it("writes hooks JSON without a UTF-8 BOM", async () => {
    await withTempHome(async (homeDir) => {
      const { deps } = makeFileDeps("win32", homeDir);

      await runSetup(["--install-review-gate"], deps);

      const bytes = await readFile(path.join(homeDir, ".codex", "hooks.json"));
      expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    });
  });
});
