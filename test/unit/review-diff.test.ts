import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ClaudeEnvelope } from "../../src/claude/parse-output.js";
import type { RunnerRequest } from "../../src/claude/runner.js";
import { isClaudeConsultError } from "../../src/errors.js";
import { runCommand } from "../../src/run-command.js";
import { createReviewDiffTool } from "../../src/tools/review-diff.js";
import type { ToolContext } from "../../src/tools/shared-schemas.js";

const SESSION_ID = "123e4567-e89b-12d3-a456-426614174000";

const FIXTURE_ENVELOPE: ClaudeEnvelope = Object.freeze({
  result: "diff review",
  structuredOutput: undefined,
  sessionId: SESSION_ID,
  isError: false,
  subtype: undefined,
  apiErrorStatus: undefined,
  totalCostUsd: 0.12,
  durationMs: 3400,
  numTurns: 2
});

function makeContext(): { requests: RunnerRequest[]; context: ToolContext } {
  const requests: RunnerRequest[] = [];
  return {
    requests,
    context: {
      runClaude: async (request) => {
        requests.push(request);
        return FIXTURE_ENVELOPE;
      }
    }
  };
}

function textOf(result: unknown): string {
  return (result as { readonly content?: readonly { readonly text?: string }[] }).content?.[0]?.text ?? "";
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runCommand("git", args, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "ccm-review-diff-"));
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "t@t"]);
  await git(repo, ["config", "user.name", "t"]);
  await writeFile(path.join(repo, "a.ts"), "export const value = 1;\n");
  await git(repo, ["add", "a.ts"]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

async function commitAll(repo: string, message: string): Promise<string> {
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("claude_review_diff tool", () => {
  it("reviews uncommitted changes against HEAD and grants repo context", async () => {
    const repo = await makeRepo();
    await writeFile(path.join(repo, "a.ts"), "export const value = 2;\n");
    const { requests, context } = makeContext();
    const tool = createReviewDiffTool(context);

    const result = await tool.execute({ workspace_dir: repo });

    expect(textOf(result)).toContain("diff review");
    const request = requests[0];
    expect(request?.cwd).toBe(repo);
    expect(request?.addDirs).toEqual([repo]);
    expect(request?.prompt).toContain("<git-status>");
    expect(request?.prompt).toContain("a.ts");
    expect(request?.prompt).toContain("+export const value = 2;");
    expect(request?.prompt).toContain("Review these changes for correctness, security, and simplicity.");
  });

  it("reviews committed changes since a base ref", async () => {
    const repo = await makeRepo();
    const firstCommit = await git(repo, ["rev-parse", "HEAD"]);
    await writeFile(path.join(repo, "a.ts"), "export const value = 3;\n");
    await commitAll(repo, "change value");
    const { requests, context } = makeContext();
    const tool = createReviewDiffTool(context);

    await tool.execute({ workspace_dir: repo, base: firstCommit });

    expect(requests[0]?.prompt).toContain("(clean)");
    expect(requests[0]?.prompt).toContain("+export const value = 3;");
  });

  it.each(["-x", "master --output=x", "..", "x".repeat(200)])("rejects bad refs before invoking Claude: %s", async (base) => {
    const repo = await makeRepo();
    const { requests, context } = makeContext();
    const tool = createReviewDiffTool(context);

    await expect(tool.execute({ workspace_dir: repo, base })).rejects.toBeDefined();
    expect(requests).toHaveLength(0);
  });

  it("rejects non-repository directories without invoking Claude", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ccm-not-repo-"));
    const { requests, context } = makeContext();
    const tool = createReviewDiffTool(context);

    try {
      await tool.execute({ workspace_dir: dir });
      expect.unreachable("expected INVALID_INPUT");
    } catch (error) {
      expect(isClaudeConsultError(error)).toBe(true);
      if (isClaudeConsultError(error)) {
        expect(error.code).toBe("INVALID_INPUT");
        expect(error.message).toContain("workspace_dir is not inside a git repository");
      }
    }
    expect(requests).toHaveLength(0);
  });

  it("short-circuits clean repositories without a footer or Claude call", async () => {
    const repo = await makeRepo();
    const { requests, context } = makeContext();
    const tool = createReviewDiffTool(context);

    const result = await tool.execute({ workspace_dir: repo });

    expect(textOf(result)).toBe(`No changes to review in ${repo}.`);
    expect(textOf(result)).not.toContain("[claude-consult]");
    expect(requests).toHaveLength(0);
  });

  it("rejects oversized diffs", async () => {
    const repo = await makeRepo();
    await writeFile(path.join(repo, "a.ts"), `${"x".repeat(301_000)}\n`);
    const { requests, context } = makeContext();
    const tool = createReviewDiffTool(context);

    await expect(tool.execute({ workspace_dir: repo })).rejects.toBeDefined();
    expect(requests).toHaveLength(0);
  });

  it("embeds a custom review question", async () => {
    const repo = await makeRepo();
    await mkdir(path.join(repo, "src"));
    await writeFile(path.join(repo, "src", "b.ts"), "export const risk = true;\n");
    const { requests, context } = makeContext();
    const tool = createReviewDiffTool(context);

    await tool.execute({ workspace_dir: repo, question: "Focus on API compatibility.", depth: "deep" });

    expect(requests[0]?.prompt).toContain("<question>\nFocus on API compatibility.\n</question>");
    expect(requests[0]?.depth).toBe("deep");
  });

  it("does not execute configured external diff commands", async () => {
    const repo = await makeRepo();
    const marker = path.join(repo, "external-diff-ran.txt");
    const script = path.join(repo, "external-diff.js");
    await writeFile(script, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed"); process.stdout.write("EXTERNAL_DIFF_USED\\n");\n`);
    await git(repo, ["config", "diff.external", `node ${script.replace(/\\/g, "/")}`]);
    await writeFile(path.join(repo, "a.ts"), "export const value = 4;\n");
    const { requests, context } = makeContext();
    const tool = createReviewDiffTool(context);

    await tool.execute({ workspace_dir: repo });

    expect(await exists(marker)).toBe(false);
    expect(requests[0]?.prompt).toContain("+export const value = 4;");
    expect(requests[0]?.prompt).not.toContain("EXTERNAL_DIFF_USED");
  });
});
