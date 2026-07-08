import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Logger } from "../logger.js";
import { KILL_GRACE_MS } from "../claude/kill-tree.js";

const EXIT_BUFFER_MS = 500;

export interface ProcessLike {
  on(event: string, listener: () => void): unknown;
  exit(code: number): void;
}

export interface RunServerDeps {
  readonly server: McpServer;
  readonly logger: Logger;
  readonly killInFlight: () => number;
  readonly processLike?: ProcessLike | undefined;
  readonly createTransport?: (() => Transport) | undefined;
  readonly setTimer?: ((fn: () => void, ms: number) => void) | undefined;
}

export async function runServer(deps: RunServerDeps): Promise<void> {
  const processLike: ProcessLike = deps.processLike ?? process;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => {
    setTimeout(fn, ms);
  });
  const transport = (deps.createTransport ?? (() => new StdioServerTransport()))();

  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    const pending = deps.killInFlight();
    deps.logger.info(`shutting down (${reason}); terminating ${pending} in-flight claude run(s)`);
    // When children are in flight, defer exit past the SIGKILL follow-up so the
    // process tree is really gone before we leave. process.exit would otherwise
    // cancel that pending timer and orphan a child that ignored SIGTERM.
    const delay = pending > 0 ? KILL_GRACE_MS + EXIT_BUFFER_MS : 0;
    setTimer(() => processLike.exit(0), delay);
  };

  processLike.on("SIGINT", () => shutdown("SIGINT"));
  processLike.on("SIGTERM", () => shutdown("SIGTERM"));
  deps.server.server.onclose = () => {
    shutdown("transport closed");
  };

  await deps.server.connect(transport);
  deps.logger.info("claude-consult-mcp connected over stdio");
}
