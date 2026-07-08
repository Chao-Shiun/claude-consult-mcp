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
import { createSecondOpinionTool, CRITICAL_REVIEWER_PROMPT, VERDICT_JSON_SCHEMA } from "../../src/tools/second-opinion.js";
import { commonAncestor } from "../../src/tools/path-analysis.js";
import { createReviewFilesTool } from "../../src/tools/review-files.js";
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

function expectSuccessResult(result: unknown): void {
  const text = (result as { readonly content?: readonly { readonly text?: string }[] }).content?.[0]?.text;
  expect(text).toContain(FIXTURE_ENVELOPE.result);
  expect(text).toContain(`session_id: ${SESSION_ID}`);
}

describe("ask_claude tool", () => {
  it("keeps the advisor prompt anchored to precise evidence discipline", () => {
    expect(ADVISOR_SYSTEM_PROMPT).toContain("Every claim you make must cite its evidence precisely: a file path with line numbers you actually read, or a URL you actually fetched. When the caller supplies claims about files or documents you can access, verify them yourself before relying on them, and state what you found. If you change your position, name the specific evidence that persuaded you.");
  });

  it("sends the bare question with the advisor system prompt", async () => {
    const { requests, context } = makeContext();
    const tool = createAskClaudeTool(context);
    expect(tool.name).toBe("ask_claude");
    const result = await tool.execute({ question: "why is the sky blue?" });
    expectSuccessResult(result);
    expect(requests[0]?.prompt).toBe("why is the sky blue?");
    expect(requests[0]?.appendSystemPrompt).toBe(ADVISOR_SYSTEM_PROMPT);
    expect(requests[0]?.cwd).toBeUndefined();
    expect(requests[0]).not.toHaveProperty("jsonSchema");
  });

  it("wraps context in background tags and forwards common args", async () => {
    const { requests, context } = makeContext();
    const tool = createAskClaudeTool(context);
    await tool.execute({ question: "q", context: "tried X", workspace_dir: WORKSPACE_DIR, model: "haiku", session_id: SESSION_ID });
    const request = requests[0];
    expect(request?.prompt).toBe("<background-context>\ntried X\n</background-context>\n\nq");
    expect(request?.cwd).toBe(WORKSPACE_DIR);
    expect(request?.model).toBe("haiku");
    expect(request?.sessionId).toBe(SESSION_ID);
    expect(request).not.toHaveProperty("budgetUsd");
  });

  it("rejects a missing question at the schema boundary", async () => {
    const { context } = makeContext();
    const tool = createAskClaudeTool(context);
    await expect(tool.execute({})).rejects.toBeDefined();
  });
});

describe("claude_second_opinion tool", () => {
  it("keeps the reviewer prompt anchored to claim verification", () => {
    expect(CRITICAL_REVIEWER_PROMPT).toContain("For each substantive claim in the analysis under review, verify it against the actual files or sources when they are accessible, and label it verified, refuted, or cannot_verify together with your evidence.");
  });

  it("wraps problem and analysis in review tags with the critical reviewer prompt", async () => {
    const { requests, context } = makeContext();
    const tool = createSecondOpinionTool(context);
    expect(tool.name).toBe("claude_second_opinion");
    const result = await tool.execute({ problem: "cache misses", analysis: "we think TTL is wrong" });
    expectSuccessResult(result);
    const request = requests[0];
    expect(request?.prompt).toContain("<problem>\ncache misses\n</problem>");
    expect(request?.prompt).toContain("<analysis-under-review>\nwe think TTL is wrong\n</analysis-under-review>");
    expect(request?.appendSystemPrompt).toContain(ADVISOR_SYSTEM_PROMPT);
    expect(request?.appendSystemPrompt).toContain("Verdict");
    expect(request?.appendSystemPrompt).toContain("not to be agreeable");
    expect(request?.jsonSchema).toBe(VERDICT_JSON_SCHEMA);
    expect(tool.description).toContain("The result body is a JSON document with fields verdict (agree|partial|disagree), confidence (0-1), claim_verifications (each caller claim labeled verified|refuted|cannot_verify with evidence), flaws, missed_considerations, suggested_changes, and summary_markdown - parse it and gate your next action on verdict and confidence.");
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
    const result = await tool.execute({ paths: [fileA, subDir, fileB], question: "find the bug" });
    expectSuccessResult(result);
    const request = requests[0];
    expect(request?.prompt).toContain(fileA);
    expect(request?.prompt).toContain(subDir);
    expect(request?.prompt).toContain("find the bug");
    expect(request?.appendSystemPrompt).toContain(ADVISOR_SYSTEM_PROMPT);
    expect(request?.addDirs).toEqual([base, subDir]);
    expect(request?.cwd).toBe(base);
    expect(request).not.toHaveProperty("jsonSchema");
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
    const result = await tool.execute({ session_id: SESSION_ID, message: "and double it", workspace_dir: WORKSPACE_DIR });
    expectSuccessResult(result);
    const request = requests[0];
    expect(request?.prompt).toBe("and double it");
    expect(request?.sessionId).toBe(SESSION_ID);
    expect(request?.cwd).toBe(WORKSPACE_DIR);
    expect(request?.appendSystemPrompt).toContain(ADVISOR_SYSTEM_PROMPT);
    expect(request?.appendSystemPrompt).not.toContain("not to be agreeable");
    expect(request).not.toHaveProperty("jsonSchema");
  });

  it("keeps a critical stance on adversarial review follow-ups", async () => {
    const { requests, context } = makeContext();
    const tool = createContinueSessionTool(context);
    await tool.execute({ session_id: SESSION_ID, message: "rebut this", workspace_dir: WORKSPACE_DIR, stance: "critical" });
    expect(requests[0]?.appendSystemPrompt).toContain(ADVISOR_SYSTEM_PROMPT);
    expect(requests[0]?.appendSystemPrompt).toContain("not to be agreeable");
    expect(requests[0]?.appendSystemPrompt).toContain("verified, refuted, or cannot_verify");
  });

  it("rejects unknown continuation stances", async () => {
    const { requests, context } = makeContext();
    const tool = createContinueSessionTool(context);
    await expect(tool.execute({ session_id: SESSION_ID, message: "hi", stance: "friendly" })).rejects.toBeDefined();
    expect(requests).toHaveLength(0);
  });

  it("requires a session id", async () => {
    const { context } = makeContext();
    const tool = createContinueSessionTool(context);
    await expect(tool.execute({ message: "hi" })).rejects.toBeDefined();
  });
});
