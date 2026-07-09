import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeConsultError } from "../../src/errors.js";
import { createLogger } from "../../src/logger.js";
import type { ClaudeEnvelope } from "../../src/claude/parse-output.js";
import type { RunnerRequest } from "../../src/claude/runner.js";
import { createServer } from "../../src/server/create-server.js";

const SESSION_ID = "123e4567-e89b-12d3-a456-426614174000";
const silentLogger = createLogger("silent", { write: () => true });

const FIXTURE_ENVELOPE: ClaudeEnvelope = Object.freeze({
  result: "the answer",
  structuredOutput: undefined,
  sessionId: SESSION_ID,
  isError: false,
  subtype: undefined,
  apiErrorStatus: undefined,
  totalCostUsd: 0.12,
  durationMs: 3400,
  numTurns: 2
});

interface TestHarness {
  client: Client;
  requests: RunnerRequest[];
  stdoutWrites: number;
  close: () => Promise<void>;
}

interface HarnessOptions {
  readonly runClaudeError?: unknown;
  readonly runClaude?: (request: RunnerRequest) => Promise<ClaudeEnvelope>;
  readonly progressHeartbeatMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHarnessOptions(value: unknown): value is HarnessOptions {
  return value !== null && typeof value === "object" && ("runClaude" in value || "runClaudeError" in value || "progressHeartbeatMs" in value);
}

async function startHarness(optionsOrError?: HarnessOptions | unknown): Promise<TestHarness> {
  const options: HarnessOptions = isHarnessOptions(optionsOrError)
    ? optionsOrError
    : { runClaudeError: optionsOrError };
  const requests: RunnerRequest[] = [];
  const runClaude = async (request: RunnerRequest): Promise<ClaudeEnvelope> => {
    requests.push(request);
    if (options.runClaudeError !== undefined) {
      throw options.runClaudeError;
    }
    return options.runClaude === undefined ? FIXTURE_ENVELOPE : options.runClaude(request);
  };
  const server = createServer({ runClaude, logger: silentLogger, progressHeartbeatMs: options.progressHeartbeatMs });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "protocol-test", version: "0.0.1" });
  let stdoutWrites = 0;
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => {
    stdoutWrites += 1;
    return true;
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    requests,
    get stdoutWrites() {
      return stdoutWrites;
    },
    close: async () => {
      spy.mockRestore();
      await client.close();
      await server.close();
    }
  } as TestHarness;
}

describe("MCP protocol layer", () => {
  let harness: TestHarness | undefined;

  beforeEach(() => {
    harness = undefined;
  });

  afterEach(async () => {
    await harness?.close();
  });

  it("exposes server instructions to connected clients", async () => {
    harness = await startHarness();
    expect(harness.client.getInstructions()).toContain("independent cross-model");
    expect(harness.client.getInstructions()).toContain("claude_panel");
    expect(harness.client.getInstructions()).toContain("stance \"critical\"");
    expect(harness.client.getInstructions()).toContain("claude_review_diff");
  });

  it("lists exactly the eight consult tools with steering schemas", async () => {
    harness = await startHarness();
    const listed = await harness.client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["ask_claude", "claude_continue", "claude_debate_open", "claude_debate_reply", "claude_panel", "claude_review_diff", "claude_review_files", "claude_second_opinion"]);
    const ask = listed.tools.find((tool) => tool.name === "ask_claude");
    expect(ask?.description).toContain("advisory only");
    expect(ask?.description).toContain("claude_panel");
    const secondOpinion = listed.tools.find((tool) => tool.name === "claude_second_opinion");
    expect(secondOpinion?.description).toContain("sub-agents");
    expect(secondOpinion?.description).toContain("format: prose");
    const reviewDiff = listed.tools.find((tool) => tool.name === "claude_review_diff");
    expect(reviewDiff?.description).toContain("actual code changes");
    expect((reviewDiff?.inputSchema as { required?: string[] }).required).toEqual(["workspace_dir"]);
    const properties = (ask?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(properties).sort()).toEqual(["context", "model", "question", "session_id", "workspace_dir"]);
    expect((ask?.inputSchema as { required?: string[] }).required).toEqual(["question"]);
    const continueTool = listed.tools.find((tool) => tool.name === "claude_continue");
    expect((continueTool?.inputSchema as { required?: string[] }).required?.sort()).toEqual(["message", "session_id"]);
    const continueProperties = (continueTool?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(continueProperties).sort()).toEqual(["message", "model", "session_id", "stance", "workspace_dir"]);
    expect((continueProperties.stance as { enum?: string[] }).enum).toEqual(["neutral", "critical"]);
    const panel = listed.tools.find((tool) => tool.name === "claude_panel");
    const panelProperties = (panel?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    const perspectives = panelProperties.perspectives as { items?: { enum?: string[] } };
    expect(perspectives.items?.enum).toEqual(["correctness", "security", "performance", "simplicity", "architecture", "testing"]);
    expect((panel?.inputSchema as { required?: string[] }).required).toEqual(["task"]);
    const debateOpen = listed.tools.find((tool) => tool.name === "claude_debate_open");
    expect(debateOpen?.description).toContain("Open a structured, evidence-based debate");
    expect(debateOpen?.description).toContain("format: prose");
    expect((debateOpen?.inputSchema as { required?: string[] }).required?.sort()).toEqual(["evidence", "position", "topic", "workspace_dir"]);
    const debateReply = listed.tools.find((tool) => tool.name === "claude_debate_reply");
    expect(debateReply?.description).toContain("format: prose");
  });

  it("returns the answer with the footer on a successful call", async () => {
    harness = await startHarness();
    const result = await harness.client.callTool({ name: "ask_claude", arguments: { question: "why?" } });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(result.isError ?? false).toBe(false);
    expect(content[0]?.text).toContain("the answer");
    expect(content[0]?.text).toContain(`session_id: ${SESSION_ID}`);
    expect(harness.requests).toHaveLength(1);
  });

  it("returns a default three-perspective panel report", async () => {
    harness = await startHarness();
    const result = await harness.client.callTool({ name: "claude_panel", arguments: { task: "review this" } });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(result.isError ?? false).toBe(false);
    expect(content[0]?.text).toContain("## Perspective: correctness");
    expect(content[0]?.text).toContain("## Perspective: security");
    expect(content[0]?.text).toContain("## Perspective: simplicity");
    expect(harness.requests).toHaveLength(3);
  });

  it("returns schema violations as error results without invoking the runner", async () => {
    harness = await startHarness();
    const result = await harness.client.callTool({ name: "ask_claude", arguments: { question: "q", session_id: "not-a-uuid" } });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("Input validation error");
    expect(content[0]?.text).toContain("session_id");
    expect(harness.requests).toHaveLength(0);
  });

  it("surfaces taxonomy errors as isError tool results", async () => {
    harness = await startHarness(new ClaudeConsultError("CLAUDE_NOT_FOUND", "claude CLI not found on PATH", "install claude code"));
    const result = await harness.client.callTool({ name: "ask_claude", arguments: { question: "q" } });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("[CLAUDE_NOT_FOUND]");
    expect(content[0]?.text).toContain("Hint:");
  });

  it("never writes to stdout during a protocol session", async () => {
    harness = await startHarness();
    await harness.client.callTool({ name: "ask_claude", arguments: { question: "q" } });
    expect(harness.stdoutWrites).toBe(0);
  });

  it("sends progress heartbeats during long tool calls when the client asks for progress", async () => {
    const progressEvents: Array<{ progress: number; message?: string }> = [];
    harness = await startHarness({ progressHeartbeatMs: 50, runClaude: async () => {
      await sleep(130);
      return FIXTURE_ENVELOPE;
    } });
    const result = await harness.client.callTool({ name: "ask_claude", arguments: { question: "slow?" } }, undefined, {
      onprogress: (progress) => {
        progressEvents.push(progress);
      }
    });
    expect(result.isError ?? false).toBe(false);
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
    expect(progressEvents[0]?.message).toContain("ask_claude running");
    expect(progressEvents[0]?.message).toContain("elapsed");
    expect(progressEvents[0]?.progress).toBeGreaterThan(0);
    const settledCount = progressEvents.length;
    await sleep(120);
    expect(progressEvents).toHaveLength(settledCount);
  });

  it("does not start a progress timer when the client does not ask for progress", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    harness = await startHarness({ progressHeartbeatMs: 50, runClaude: async () => {
      await sleep(80);
      return FIXTURE_ENVELOPE;
    } });
    const result = await harness.client.callTool({ name: "ask_claude", arguments: { question: "slow?" } });
    expect(result.isError ?? false).toBe(false);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it("propagates client cancellation to the tool runner signal", async () => {
    let observedSignal: AbortSignal | undefined;
    harness = await startHarness({ runClaude: async (request: RunnerRequest) => {
      observedSignal = request.signal;
      return new Promise<ClaudeEnvelope>((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => {
          reject(new ClaudeConsultError("REQUEST_CANCELLED", "the tool call was cancelled by the caller before claude finished", "no action needed; re-issue the call if the cancellation was accidental"));
        }, { once: true });
      });
    } });
    const controller = new AbortController();
    const call = harness.client.callTool({ name: "ask_claude", arguments: { question: "cancel this" } }, undefined, { signal: controller.signal });
    for (let attempt = 0; attempt < 10 && observedSignal === undefined; attempt += 1) {
      await sleep(0);
    }
    expect(observedSignal).toBeDefined();
    controller.abort();
    await expect(call.catch((error: unknown) => error)).resolves.toBeDefined();
    expect(observedSignal?.aborted).toBe(true);
  });
});
