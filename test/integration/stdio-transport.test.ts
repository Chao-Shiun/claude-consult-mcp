import { existsSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

const DIST_ENTRY = path.resolve(process.cwd(), "dist", "index.js");

describe.skipIf(!existsSync(DIST_ENTRY))("stdio transport end to end", () => {
  it("spawns the built binary and lists the eight tools over real stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_ENTRY],
      env: { ...process.env, CLAUDE_CONSULT_LOG_LEVEL: "silent" } as Record<string, string>
    });
    const client = new Client({ name: "stdio-e2e", version: "0.0.1" });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      expect(names).toEqual(["ask_claude", "claude_continue", "claude_debate_open", "claude_debate_reply", "claude_panel", "claude_review_diff", "claude_review_files", "claude_second_opinion"]);
    } finally {
      await client.close();
    }
  }, 30_000);
});
