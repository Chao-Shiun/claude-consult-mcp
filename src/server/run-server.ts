import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Logger } from "../logger.js";

export interface ProcessLike {
  on(event: string, listener: () => void): unknown;
  exit(code: number): void;
}

export interface RunServerDeps {
  readonly server: McpServer;
  readonly logger: Logger;
  readonly killInFlight: () => void;
  readonly processLike?: ProcessLike | undefined;
  readonly createTransport?: (() => Transport) | undefined;
}

export async function runServer(deps: RunServerDeps): Promise<void> {
  const processLike: ProcessLike = deps.processLike ?? process;
  const transport = (deps.createTransport ?? (() => new StdioServerTransport()))();

  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    deps.logger.info(`shutting down (${reason}); terminating in-flight claude runs`);
    deps.killInFlight();
  };

  processLike.on("SIGINT", () => {
    shutdown("SIGINT");
    processLike.exit(0);
  });
  processLike.on("SIGTERM", () => {
    shutdown("SIGTERM");
    processLike.exit(0);
  });
  deps.server.server.onclose = () => {
    shutdown("transport closed");
  };

  await deps.server.connect(transport);
  deps.logger.info("claude-consult-mcp connected over stdio");
}
