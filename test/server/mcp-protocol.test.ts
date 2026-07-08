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

async function startHarness(runClaudeError?: unknown): Promise<TestHarness> {
  const requests: RunnerRequest[] = [];
  const runClaude = async (request: RunnerRequest): Promise<ClaudeEnvelope> => {
    requests.push(request);
    if (runClaudeError !== undefined) {
      throw runClaudeError;
    }
    return FIXTURE_ENVELOPE;
  };
  const server = createServer({ runClaude, logger: silentLogger });
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
  });

  it("lists exactly the four consult tools with steering schemas", async () => {
    harness = await startHarness();
    const listed = await harness.client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["ask_claude", "claude_continue", "claude_review_files", "claude_second_opinion"]);
    const ask = listed.tools.find((tool) => tool.name === "ask_claude");
    expect(ask?.description).toContain("advisory only");
    expect(ask?.description).toContain("claude_panel");
    const secondOpinion = listed.tools.find((tool) => tool.name === "claude_second_opinion");
    expect(secondOpinion?.description).toContain("sub-agents");
    const properties = (ask?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(properties).sort()).toEqual(["budget_usd", "context", "model", "question", "session_id", "workspace_dir"]);
    expect((ask?.inputSchema as { required?: string[] }).required).toEqual(["question"]);
    const continueTool = listed.tools.find((tool) => tool.name === "claude_continue");
    expect((continueTool?.inputSchema as { required?: string[] }).required?.sort()).toEqual(["message", "session_id"]);
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
});
