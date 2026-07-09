import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeConsultError, isClaudeConsultError } from "../../src/errors.js";
import type { ClaudeEnvelope } from "../../src/claude/parse-output.js";
import type { RunnerRequest } from "../../src/claude/runner.js";
import { ADVISOR_SYSTEM_PROMPT } from "../../src/tools/advisor-prompt.js";
import { createPanelTool } from "../../src/tools/panel.js";
import type { ToolContext } from "../../src/tools/shared-schemas.js";

const SESSION_IDS = [
  "123e4567-e89b-12d3-a456-426614174000",
  "123e4567-e89b-12d3-a456-426614174001",
  "123e4567-e89b-12d3-a456-426614174002",
  "123e4567-e89b-12d3-a456-426614174003"
] as const;

function envelope(index: number, result = `answer ${index}`): ClaudeEnvelope {
  return Object.freeze({
    result,
    structuredOutput: undefined,
    sessionId: SESSION_IDS[index] ?? SESSION_IDS[0],
    isError: false,
    subtype: undefined,
    apiErrorStatus: undefined,
    totalCostUsd: index + 0.1,
    durationMs: 1000 + index,
    numTurns: 1
  });
}

function makeContext(respond?: (request: RunnerRequest, index: number) => Promise<ClaudeEnvelope>): { requests: RunnerRequest[]; context: ToolContext } {
  const requests: RunnerRequest[] = [];
  return {
    requests,
    context: {
      runClaude: async (request) => {
        const index = requests.length;
        requests.push(request);
        return respond === undefined ? envelope(index) : respond(request, index);
      }
    }
  };
}

function textOf(result: unknown): string {
  return (result as { readonly content?: readonly { readonly text?: string }[] }).content?.[0]?.text ?? "";
}

describe("claude_panel tool", () => {
  it("runs the default perspectives with advisor prompts and fresh sessions", async () => {
    const { requests, context } = makeContext();
    const tool = createPanelTool(context);
    const signal = new AbortController().signal;
    const result = await tool.execute({ task: "review this design" }, { signal });
    expect(textOf(result)).toContain("# Claude panel: 3 perspective(s)");
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.appendSystemPrompt)).toEqual([
      expect.stringContaining("correctness reviewer"),
      expect.stringContaining("security reviewer"),
      expect.stringContaining("simplicity reviewer")
    ]);
    for (const request of requests) {
      expect(request.appendSystemPrompt).toContain(ADVISOR_SYSTEM_PROMPT);
      expect(request.signal).toBe(signal);
      expect(request.prompt).toBe(requests[0]?.prompt);
      expect(request).not.toHaveProperty("sessionId");
      expect(request).not.toHaveProperty("jsonSchema");
    }
  });

  it("accepts custom perspectives in order and rejects duplicate or unknown entries", async () => {
    const { requests, context } = makeContext();
    const tool = createPanelTool(context);
    const result = await tool.execute({ task: "review auth", perspectives: ["security", "testing"] });
    expect(requests).toHaveLength(2);
    expect(textOf(result).indexOf("## Perspective: security")).toBeLessThan(textOf(result).indexOf("## Perspective: testing"));
    await expect(tool.execute({ task: "review auth", perspectives: ["security", "security"] })).rejects.toBeDefined();
    await expect(tool.execute({ task: "review auth", perspectives: ["security", "red-team"] })).rejects.toBeDefined();
  });

  it("aggregates successful perspective results with individual footers", async () => {
    const { context } = makeContext();
    const tool = createPanelTool(context);
    const result = await tool.execute({ task: "review auth", perspectives: ["security", "testing"] });
    const text = textOf(result);
    expect(text).toContain("## Perspective: security");
    expect(text).toContain("## Perspective: testing");
    expect(text).toContain(`session_id: ${SESSION_IDS[0]}`);
    expect(text).toContain(`session_id: ${SESSION_IDS[1]}`);
  });

  it("keeps partial failures as failed sections without making the whole result an error", async () => {
    const { context } = makeContext(async (_request, index) => {
      if (index === 1) {
        throw new ClaudeConsultError("INVALID_INPUT", "bad panel member", "fix the request");
      }
      return envelope(index);
    });
    const tool = createPanelTool(context);
    const result = await tool.execute({ task: "review auth", perspectives: ["security", "testing", "simplicity"] });
    const text = textOf(result);
    expect((result as { readonly isError?: boolean }).isError).toBeUndefined();
    expect(text).toContain("## Perspective: testing (FAILED)");
    expect(text).toContain("[INVALID_INPUT]");
    expect(text).toContain("## Perspective: security");
    expect(text).toContain("## Perspective: simplicity");
  });

  it("marks the whole result as an error when every perspective fails", async () => {
    const { context } = makeContext(async () => {
      throw new ClaudeConsultError("CLAUDE_TIMEOUT", "too slow", "raise the timeout");
    });
    const tool = createPanelTool(context);
    const result = await tool.execute({ task: "review auth", perspectives: ["security", "testing"] });
    expect((result as { readonly isError?: boolean }).isError).toBe(true);
    expect(textOf(result).match(/\(FAILED\)/g)).toHaveLength(2);
  });

  it("analyzes paths once and forwards the derived addDirs and cwd to every request", async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "ccm-panel-"));
    const fileA = path.join(base, "a.ts");
    writeFileSync(fileA, "export const a = 1;\n");
    const subDir = path.join(base, "sub");
    mkdirSync(subDir);
    const fileB = path.join(subDir, "b.ts");
    writeFileSync(fileB, "export const b = 2;\n");

    const { requests, context } = makeContext();
    const tool = createPanelTool(context);
    await tool.execute({ task: "review files", paths: [fileA, subDir, fileB], perspectives: ["correctness", "testing"] });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.addDirs).toEqual([base, subDir]);
      expect(request.cwd).toBe(base);
      expect(request.prompt).toContain(fileA);
      expect(request.prompt).toContain(subDir);
      expect(request.prompt).toContain("Read and analyze the following paths from disk before answering.");
    }

    const missing = path.join(base, "missing.ts");
    try {
      await tool.execute({ task: "review files", paths: [missing] });
      expect.unreachable("expected INVALID_INPUT");
    } catch (error) {
      expect(isClaudeConsultError(error)).toBe(true);
      if (isClaudeConsultError(error)) {
        expect(error.code).toBe("INVALID_INPUT");
      }
    }
    expect(requests).toHaveLength(2);
  });

  it("forwards model to every panel request", async () => {
    const { requests, context } = makeContext();
    const tool = createPanelTool(context);
    await tool.execute({ task: "review model forwarding", perspectives: ["security", "testing"], model: "haiku" });
    expect(requests.map((request) => request.model)).toEqual(["haiku", "haiku"]);
  });
});
