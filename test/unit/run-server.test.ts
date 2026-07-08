import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/logger.js";
import { createServer } from "../../src/server/create-server.js";
import { runServer, type ProcessLike } from "../../src/server/run-server.js";

const silentLogger = createLogger("silent", { write: () => true });

function makeProcessLike(): { listeners: Map<string, () => void>; exits: number[]; processLike: ProcessLike } {
  const listeners = new Map<string, () => void>();
  const exits: number[] = [];
  return {
    listeners,
    exits,
    processLike: {
      on: (event: string, listener: () => void) => {
        listeners.set(event, listener);
      },
      exit: (code: number) => {
        exits.push(code);
      }
    }
  };
}

describe("runServer", () => {
  it("connects, kills in-flight children on signals, and exits", async () => {
    const kills: string[] = [];
    const server = createServer({ runClaude: async () => {
      throw new Error("not used");
    }, logger: silentLogger });
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const { listeners, exits, processLike } = makeProcessLike();
    await runServer({
      server,
      logger: silentLogger,
      killInFlight: () => kills.push("killed"),
      processLike,
      createTransport: () => serverTransport
    });
    expect(listeners.has("SIGINT")).toBe(true);
    expect(listeners.has("SIGTERM")).toBe(true);
    listeners.get("SIGINT")?.();
    expect(kills).toEqual(["killed"]);
    expect(exits).toEqual([0]);
    listeners.get("SIGTERM")?.();
    expect(kills).toEqual(["killed"]);
    expect(exits).toEqual([0, 0]);
  });

  it("kills in-flight children when the transport closes", async () => {
    const kills: string[] = [];
    const server = createServer({ runClaude: async () => {
      throw new Error("not used");
    }, logger: silentLogger });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { processLike } = makeProcessLike();
    await runServer({
      server,
      logger: silentLogger,
      killInFlight: () => kills.push("killed"),
      processLike,
      createTransport: () => serverTransport
    });
    await clientTransport.start();
    await serverTransport.close();
    expect(kills).toEqual(["killed"]);
  });
});
