import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ClaudeEnvelope } from "../../src/claude/parse-output.js";
import type { RunnerRequest } from "../../src/claude/runner.js";
import { LIMITS } from "../../src/constants.js";
import { ADVISOR_SYSTEM_PROMPT } from "../../src/tools/advisor-prompt.js";
import { createDebateOpenTool, createDebateReplyTool, DEBATE_JSON_SCHEMA, DEBATE_REFEREE_PROMPT } from "../../src/tools/debate.js";
import { CRITICAL_REVIEWER_PROMPT } from "../../src/tools/second-opinion.js";
import type { ToolContext } from "../../src/tools/shared-schemas.js";

const SESSION_ID = "123e4567-e89b-12d3-a456-426614174000";
const STRUCTURED_FORMAT_DESCRIPTION = 'Check the result footer\'s format field before parsing: format: json means the body is the requested JSON document; format: prose means Claude answered in prose instead - read it directly or retry with a stronger model rather than calling JSON.parse blindly.';
const STRUCTURED_NOTICE = '[claude-consult] structured-output-notice: Claude answered in prose instead of the requested JSON. Read the answer below directly and extract what you need; if you strictly require the JSON fields, retry once with model "sonnet" or "opus", which follow output schemas more reliably.';

const FIXTURE_ENVELOPE: ClaudeEnvelope = Object.freeze({
  result: "debate result",
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

async function makeWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "ccm-debate-"));
}

async function writeFixture(workspace: string, relativePath: string, content: string): Promise<string> {
  const file = path.join(workspace, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  return file;
}

describe("claude_debate_open tool", () => {
  it("wraps the opening position, caller evidence, neutral exhibit, referee prompt, and JSON schema", async () => {
    const workspace = await makeWorkspace();
    await writeFixture(workspace, "src/example.ts", Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"));
    const { requests, context } = makeContext();
    const tool = createDebateOpenTool(context);

    const result = await tool.execute({
      topic: "Should we trust the cache invalidation patch?",
      position: "The patch is safe because the touched line only changes logging.",
      evidence: [{ claim: "The relevant code is only line 10.", type: "file", ref: "src/example.ts:10-11", content: "caller supplied note" }],
      workspace_dir: workspace,
      model: "haiku"
    });

    const request = requests[0];
    expect(request?.prompt).toContain("A structured evidence debate has been opened. Verify before you judge.");
    expect(request?.prompt).toContain("<topic>\nShould we trust the cache invalidation patch?\n</topic>");
    expect(request?.prompt).toContain("<caller-position>\nThe patch is safe because the touched line only changes logging.\n</caller-position>");
    expect(request?.prompt).toContain("<caller-evidence>");
    expect(request?.prompt).toContain('<item id="1" type="file" ref="src/example.ts:10-11">');
    expect(request?.prompt).toContain("<claim>\nThe relevant code is only line 10.\n</claim>");
    expect(request?.prompt).toContain("<content>\ncaller supplied note\n</content>");
    expect(request?.prompt).toContain("<neutral-exhibits>");
    expect(request?.prompt).toContain('<exhibit for-item="1" ref="src/example.ts:10-11">');
    expect(request?.prompt).toContain("10: line 10");
    expect(request?.prompt).toContain("command_output items: you cannot re-run commands");
    expect(request?.appendSystemPrompt).toContain(ADVISOR_SYSTEM_PROMPT);
    expect(request?.appendSystemPrompt).toContain(CRITICAL_REVIEWER_PROMPT);
    expect(request?.appendSystemPrompt).toContain(DEBATE_REFEREE_PROMPT);
    expect(request?.jsonSchema).toBe(DEBATE_JSON_SCHEMA);
    expect(request?.addDirs).toEqual([workspace]);
    expect(request?.cwd).toBe(workspace);
    expect(request?.model).toBe("haiku");
    expect(tool.description).toContain(STRUCTURED_FORMAT_DESCRIPTION);
    const text = (result as { readonly content?: readonly { readonly text?: string }[] }).content?.[0]?.text ?? "";
    expect(text).toContain(STRUCTURED_NOTICE);
    expect(text).toContain("<prose-answer>\ndebate result\n</prose-answer>");
    expect(text).toContain("format: prose");
  });

  it("embeds unavailable exhibits for unsafe file references without leaking outside content", async () => {
    const workspace = await makeWorkspace();
    const outside = path.join(os.tmpdir(), `ccm-outside-${process.pid}.txt`);
    await writeFile(outside, "outside secret", "utf8");
    const { requests, context } = makeContext();
    const tool = createDebateOpenTool(context);

    await tool.execute({
      topic: "Path safety",
      position: "Unsafe refs should not be read.",
      evidence: [
        { claim: "parent escape", type: "file", ref: "..\\escape.txt" },
        { claim: "absolute outside", type: "file", ref: outside },
        { claim: "unc", type: "file", ref: "\\\\attacker\\share\\secret.txt" }
      ],
      workspace_dir: workspace
    });

    const prompt = requests[0]?.prompt ?? "";
    expect(prompt.match(/\(exhibit unavailable:/g)).toHaveLength(3);
    expect(prompt).not.toContain("outside secret");
  });

  it("enforces the shared neutral exhibit byte cap across opening evidence", async () => {
    const workspace = await makeWorkspace();
    await writeFixture(workspace, "first.txt", "a".repeat(40_000));
    await writeFixture(workspace, "second.txt", "b".repeat(40_000));
    const { requests, context } = makeContext();
    const tool = createDebateOpenTool(context);

    await tool.execute({
      topic: "Cap",
      position: "Both files are relevant.",
      evidence: [
        { claim: "first", type: "file", ref: "first.txt" },
        { claim: "second", type: "file", ref: "second.txt" }
      ],
      workspace_dir: workspace
    });

    const prompt = requests[0]?.prompt ?? "";
    const exhibits = prompt.slice(prompt.indexOf("<neutral-exhibits>"), prompt.indexOf("</neutral-exhibits>"));
    expect(Buffer.byteLength(exhibits, "utf8")).toBeLessThan(LIMITS.exhibitMaxBytes + 500);
    expect(exhibits).toContain("a");
    expect(exhibits).toContain("b");
  });

  it("rejects invalid opening schemas before invoking Claude", async () => {
    const workspace = await makeWorkspace();
    const { requests, context } = makeContext();
    const tool = createDebateOpenTool(context);
    const validBase = { topic: "t", position: "p", workspace_dir: workspace };

    await expect(tool.execute({ ...validBase, evidence: [] })).rejects.toBeDefined();
    await expect(tool.execute({ ...validBase, evidence: Array.from({ length: 21 }, (_, index) => ({ claim: `c${index}`, type: "reasoning", ref: `r${index}` })) })).rejects.toBeDefined();
    expect(requests).toHaveLength(0);
  });
});

describe("claude_debate_reply tool", () => {
  it("continues the debate with referee prompt, session id, accept/rebut responses, and new exhibits", async () => {
    const workspace = await makeWorkspace();
    await writeFixture(workspace, "reply.txt", "reply evidence\n");
    const { requests, context } = makeContext();
    const tool = createDebateReplyTool(context);

    const result = await tool.execute({
      session_id: SESSION_ID,
      workspace_dir: workspace,
      responses: [
        { item: "claim 1", action: "accept", argument: "I accept this because the cited line matches." },
        { item: "counter 2", action: "rebut", argument: "This misses a newer file.", evidence: { claim: "New file refutes it.", type: "file", ref: "reply.txt" } }
      ],
      model: "haiku"
    });

    const request = requests[0];
    expect(request?.sessionId).toBe(SESSION_ID);
    expect(request?.cwd).toBe(workspace);
    expect(request?.model).toBe("haiku");
    expect(request?.prompt).toContain('<round-response item="claim 1" action="accept">');
    expect(request?.prompt).toContain("<argument>\nI accept this because the cited line matches.\n</argument>");
    expect(request?.prompt).toContain('<round-response item="counter 2" action="rebut">');
    expect(request?.prompt).toContain('<item id="2.1" type="file" ref="reply.txt">');
    expect(request?.prompt).toContain("<claim>\nNew file refutes it.\n</claim>");
    expect(request?.prompt).toContain('<exhibit for-item="2.1" ref="reply.txt">');
    expect(request?.prompt).toContain("reply evidence");
    expect(request?.appendSystemPrompt).toContain(CRITICAL_REVIEWER_PROMPT);
    expect(request?.appendSystemPrompt).toContain(DEBATE_REFEREE_PROMPT);
    expect(request?.jsonSchema).toBe(DEBATE_JSON_SCHEMA);
    expect(tool.description).toContain(STRUCTURED_FORMAT_DESCRIPTION);
    const text = (result as { readonly content?: readonly { readonly text?: string }[] }).content?.[0]?.text ?? "";
    expect(text).toContain(STRUCTURED_NOTICE);
    expect(text).toContain("<prose-answer>\ndebate result\n</prose-answer>");
    expect(text).toContain("format: prose");
  });

  it("rejects invalid reply schemas before invoking Claude", async () => {
    const workspace = await makeWorkspace();
    const { requests, context } = makeContext();
    const tool = createDebateReplyTool(context);

    await expect(tool.execute({
      session_id: SESSION_ID,
      workspace_dir: workspace,
      responses: [{ item: "claim", action: "argue", argument: "bad action" }]
    })).rejects.toBeDefined();
    expect(requests).toHaveLength(0);
  });
});
