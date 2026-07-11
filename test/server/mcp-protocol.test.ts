import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeConsultError } from "../../src/errors.js";
import { createLogger } from "../../src/logger.js";
import type { ClaudeEnvelope } from "../../src/claude/parse-output.js";
import type { RunnerRequest } from "../../src/claude/runner.js";
import { createServer } from "../../src/server/create-server.js";
import type { Journal, JournalEntry } from "../../src/journal.js";
import { createSessionLedger, type SessionLedger } from "../../src/session-ledger.js";

const SESSION_ID = "123e4567-e89b-12d3-a456-426614174000";
const silentLogger = createLogger("silent", { write: () => true });
const GATE_LOG = process.platform === "win32" ? "C:\\logs\\review-gate.log" : "/logs/review-gate.log";
const JOURNAL_DIR = process.platform === "win32" ? "C:\\journal" : "/journal";

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
  readonly ledger?: SessionLedger;
  readonly journal?: Journal;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHarnessOptions(value: unknown): value is HarnessOptions {
  return value !== null && typeof value === "object" && ("runClaude" in value || "runClaudeError" in value || "progressHeartbeatMs" in value || "ledger" in value || "journal" in value || "env" in value);
}

function journalWith(entries: readonly JournalEntry[]): Journal {
  return Object.freeze({
    append: async () => undefined,
    read: async () => entries
  });
}

function expectReadOnlyAnnotations(tools: Awaited<ReturnType<Client["listTools"]>>["tools"]): void {
  for (const tool of tools) {
    expect(tool.annotations).toEqual({ readOnlyHint: true });
  }
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
  const server = createServer({
    runClaude,
    logger: silentLogger,
    progressHeartbeatMs: options.progressHeartbeatMs,
    ledger: options.ledger ?? createSessionLedger(),
    journal: options.journal,
    env: options.env
  });
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
    expect(harness.client.getInstructions()).toContain("effort");
    expect(harness.client.getInstructions()).toContain("When Claude returns questions (a 'Questions for you:' section or questions_for_caller in JSON), answer them via claude_continue instead of abandoning the thread.");
    expect(harness.client.getInstructions()).toContain("When working inside a project, pass workspace_dir so fresh conversations receive recent-consultation continuity for that workspace.");
  });

  it("lists exactly the nine consult tools without a journal", async () => {
    harness = await startHarness();
    const listed = await harness.client.listTools();
    expectReadOnlyAnnotations(listed.tools);
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["ask_claude", "claude_continue", "claude_debate_open", "claude_debate_reply", "claude_panel", "claude_review_diff", "claude_review_files", "claude_second_opinion", "claude_sessions"]);
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
    expect((properties.workspace_dir as { description?: string }).description).toContain("Pass it on fresh conversations to enable journal continuity (recent-consultation context for this workspace).");
    expect(Object.keys(properties).sort()).toEqual(["context", "effort", "model", "question", "session_id", "workspace_dir"]);
    expect((properties.effort as { enum?: string[] }).enum).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect((ask?.inputSchema as { required?: string[] }).required).toEqual(["question"]);
    const continueTool = listed.tools.find((tool) => tool.name === "claude_continue");
    expect((continueTool?.inputSchema as { required?: string[] }).required?.sort()).toEqual(["message", "session_id"]);
    const continueProperties = (continueTool?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(continueProperties).sort()).toEqual(["effort", "message", "model", "session_id", "stance", "workspace_dir"]);
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
    const sessions = listed.tools.find((tool) => tool.name === "claude_sessions");
    expect(sessions?.description).toContain("List recent Claude conversations");
    const sessionProperties = (sessions?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(sessionProperties).sort()).toEqual(["limit", "workspace_dir"]);
  });

  it("lists exactly ten consult tools with a gate log", async () => {
    harness = await startHarness({ env: { CLAUDE_CONSULT_GATE_LOG: GATE_LOG } });
    const listed = await harness.client.listTools();
    expectReadOnlyAnnotations(listed.tools);
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["ask_claude", "claude_continue", "claude_debate_open", "claude_debate_reply", "claude_gate_findings", "claude_panel", "claude_review_diff", "claude_review_files", "claude_second_opinion", "claude_sessions"]);
    const findings = listed.tools.find((tool) => tool.name === "claude_gate_findings");
    expect(findings?.description).toContain("review-gate findings");
    expect(findings?.description).toContain("claude_continue");
    const findingsProperties = (findings?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(findingsProperties).sort()).toEqual(["limit", "workspace_dir"]);
  });

  it("lists exactly eleven consult tools with a journal directory", async () => {
    harness = await startHarness({ env: { CLAUDE_CONSULT_JOURNAL_DIR: JOURNAL_DIR }, journal: journalWith([]) });
    const listed = await harness.client.listTools();
    expectReadOnlyAnnotations(listed.tools);
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["ask_claude", "claude_consult_history", "claude_continue", "claude_debate_open", "claude_debate_reply", "claude_gate_findings", "claude_panel", "claude_review_diff", "claude_review_files", "claude_second_opinion", "claude_sessions"]);
    const history = listed.tools.find((tool) => tool.name === "claude_consult_history");
    expect(history?.description).toContain("List past Claude consultations recorded in this machine's journal");
    expect(history?.description).toContain("Only available when the machine owner has set CLAUDE_CONSULT_JOURNAL_DIR.");
    const historyProperties = (history?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(historyProperties).sort()).toEqual(["limit", "workspace_dir"]);
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

  it("lists sessions without invoking the Claude runner", async () => {
    harness = await startHarness();
    const result = await harness.client.callTool({ name: "claude_sessions", arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toBe("No conversations recorded since this MCP server started.");
    expect(harness.requests).toHaveLength(0);
  });

  it("lists journal history without invoking the Claude runner", async () => {
    harness = await startHarness({ journal: journalWith([{
      ts: "2026-07-09T03:20:11.000Z",
      tool: "ask_claude",
      sessionId: SESSION_ID,
      workspaceDir: undefined,
      model: undefined,
      excerpt: "topic",
      costUsd: undefined,
      durationMs: undefined
    }]) });
    const result = await harness.client.callTool({ name: "claude_consult_history", arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("Past Claude consultations (newest first):");
    expect(content[0]?.text).toContain(`session_id: ${SESSION_ID}`);
    expect(harness.requests).toHaveLength(0);
  });
});
