import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isClaudeConsultError } from "../../src/errors.js";
import type { ClaudeEnvelope } from "../../src/claude/parse-output.js";
import type { RunnerRequest } from "../../src/claude/runner.js";
import { ADVISOR_SYSTEM_PROMPT } from "../../src/tools/advisor-prompt.js";
import type { ToolContext } from "../../src/tools/shared-schemas.js";
import { createAskClaudeTool } from "../../src/tools/ask-claude.js";
import { createSecondOpinionTool } from "../../src/tools/second-opinion.js";
import { commonAncestor, createReviewFilesTool } from "../../src/tools/review-files.js";
import { createContinueSessionTool } from "../../src/tools/continue-session.js";

const SESSION_ID = "123e4567-e89b-12d3-a456-426614174000";

// workspace_dir must be absolute on the host platform; CI runs this suite on
// Windows, macOS, and Linux.
const WORKSPACE_DIR = process.platform === "win32" ? "C:\\proj" : "/proj";

const FIXTURE_ENVELOPE: ClaudeEnvelope = Object.freeze({
  result: "the answer",
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

describe("ask_claude tool", () => {
  it("sends the bare question with the advisor system prompt", async () => {
    const { requests, context } = makeContext();
    const tool = createAskClaudeTool(context);
    expect(tool.name).toBe("ask_claude");
    const envelope = await tool.execute({ question: "why is the sky blue?" });
    expect(envelope).toBe(FIXTURE_ENVELOPE);
    expect(requests[0]?.prompt).toBe("why is the sky blue?");
    expect(requests[0]?.appendSystemPrompt).toBe(ADVISOR_SYSTEM_PROMPT);
    expect(requests[0]?.cwd).toBeUndefined();
  });

  it("wraps context in background tags and forwards common args", async () => {
    const { requests, context } = makeContext();
    const tool = createAskClaudeTool(context);
    await tool.execute({ question: "q", context: "tried X", workspace_dir: WORKSPACE_DIR, model: "haiku", budget_usd: 0.5, session_id: SESSION_ID });
    const request = requests[0];
    expect(request?.prompt).toBe("<background-context>\ntried X\n</background-context>\n\nq");
    expect(request?.cwd).toBe(WORKSPACE_DIR);
    expect(request?.model).toBe("haiku");
    expect(request?.budgetUsd).toBe(0.5);
    expect(request?.sessionId).toBe(SESSION_ID);
  });

  it("rejects a missing question at the schema boundary", async () => {
    const { context } = makeContext();
    const tool = createAskClaudeTool(context);
    await expect(tool.execute({})).rejects.toBeDefined();
  });
});

describe("claude_second_opinion tool", () => {
  it("wraps problem and analysis in review tags with the critical reviewer prompt", async () => {
    const { requests, context } = makeContext();
    const tool = createSecondOpinionTool(context);
    expect(tool.name).toBe("claude_second_opinion");
    await tool.execute({ problem: "cache misses", analysis: "we think TTL is wrong" });
    const request = requests[0];
    expect(request?.prompt).toContain("<problem>\ncache misses\n</problem>");
    expect(request?.prompt).toContain("<analysis-under-review>\nwe think TTL is wrong\n</analysis-under-review>");
    expect(request?.appendSystemPrompt).toContain(ADVISOR_SYSTEM_PROMPT);
    expect(request?.appendSystemPrompt).toContain("Verdict");
    expect(request?.appendSystemPrompt).toContain("not to be agreeable");
  });
});

describe("claude_review_files tool", () => {
  it("validates existence, derives cwd and add-dirs, and lists paths in the prompt", async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "ccm-review-"));
    const fileA = path.join(base, "a.ts");
    writeFileSync(fileA, "export const a = 1;\n");
    const subDir = path.join(base, "sub");
    mkdirSync(subDir);
    const fileB = path.join(subDir, "b.ts");
    writeFileSync(fileB, "export const b = 2;\n");

    const { requests, context } = makeContext();
    const tool = createReviewFilesTool(context);
    expect(tool.name).toBe("claude_review_files");
    await tool.execute({ paths: [fileA, subDir, fileB], question: "find the bug" });
    const request = requests[0];
    expect(request?.prompt).toContain(fileA);
    expect(request?.prompt).toContain(subDir);
    expect(request?.prompt).toContain("find the bug");
    expect(request?.appendSystemPrompt).toContain(ADVISOR_SYSTEM_PROMPT);
    expect(request?.addDirs).toEqual([base, subDir]);
    expect(request?.cwd).toBe(base);
  });

  it("prefers an explicit workspace_dir as cwd", async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "ccm-review-"));
    const fileA = path.join(base, "a.ts");
    writeFileSync(fileA, "export const a = 1;\n");
    const { requests, context } = makeContext();
    const tool = createReviewFilesTool(context);
    await tool.execute({ paths: [fileA], question: "q", workspace_dir: base });
    expect(requests[0]?.cwd).toBe(base);
  });

  it("lists every missing path in one INVALID_INPUT error", async () => {
    const { requests, context } = makeContext();
    const tool = createReviewFilesTool(context);
    const missingBase = path.join(os.tmpdir(), `ccm-definitely-missing-${process.pid}`);
    const missingA = path.join(missingBase, "a.ts");
    const missingB = path.join(missingBase, "b.ts");
    try {
      await tool.execute({ paths: [missingA, missingB], question: "q" });
      expect.unreachable("expected INVALID_INPUT");
    } catch (error) {
      expect(isClaudeConsultError(error)).toBe(true);
      if (isClaudeConsultError(error)) {
        expect(error.code).toBe("INVALID_INPUT");
        expect(error.message).toContain(missingA);
        expect(error.message).toContain(missingB);
      }
    }
    expect(requests).toHaveLength(0);
  });

  it("computes common ancestors and falls back across drives", () => {
    expect(commonAncestor(["C:\\repo\\src", "C:\\repo\\test"])).toBe("C:\\repo");
    expect(commonAncestor(["C:\\repo\\src", "C:\\repo\\src"])).toBe("C:\\repo\\src");
    expect(commonAncestor(["C:\\a", "D:\\b"])).toBeUndefined();
  });

  it("does not widen the cwd to a drive root or empty path", () => {
    expect(commonAncestor(["C:\\Users\\Alice\\foo", "C:\\Windows\\System32"])).toBeUndefined();
    expect(commonAncestor(["/etc/xxx", "/home/victim/yyy"])).toBeUndefined();
  });

  it("rejects UNC paths at the schema boundary before touching the filesystem", async () => {
    const { requests, context } = makeContext();
    const tool = createReviewFilesTool(context);
    await expect(tool.execute({ paths: ["\\\\attacker\\share\\x"], question: "q" })).rejects.toBeDefined();
    expect(requests).toHaveLength(0);
  });
});

describe("claude_continue tool", () => {
  it("forwards the message and required session id", async () => {
    const { requests, context } = makeContext();
    const tool = createContinueSessionTool(context);
    expect(tool.name).toBe("claude_continue");
    await tool.execute({ session_id: SESSION_ID, message: "and double it", workspace_dir: WORKSPACE_DIR });
    const request = requests[0];
    expect(request?.prompt).toBe("and double it");
    expect(request?.sessionId).toBe(SESSION_ID);
    expect(request?.cwd).toBe(WORKSPACE_DIR);
    expect(request?.appendSystemPrompt).toContain(ADVISOR_SYSTEM_PROMPT);
  });

  it("requires a session id", async () => {
    const { context } = makeContext();
    const tool = createContinueSessionTool(context);
    await expect(tool.execute({ message: "hi" })).rejects.toBeDefined();
  });
});
