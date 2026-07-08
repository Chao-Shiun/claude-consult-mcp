import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/logger.js";
import { createServer } from "../../src/server/create-server.js";
import { runServer, type ProcessLike } from "../../src/server/run-server.js";

const silentLogger = createLogger("silent", { write: () => true });

interface TimerCall {
  fn: () => void;
  ms: number;
}

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

function makeStubServer() {
  return createServer({ runClaude: async () => {
    throw new Error("not used");
  }, logger: silentLogger });
}

describe("runServer", () => {
  it("waits for the kill grace period before exiting when children are in flight", async () => {
    const kills: string[] = [];
    const timers: TimerCall[] = [];
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const { listeners, exits, processLike } = makeProcessLike();
    await runServer({
      server: makeStubServer(),
      logger: silentLogger,
      killInFlight: () => {
        kills.push("killed");
        return 1;
      },
      processLike,
      createTransport: () => serverTransport,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
      }
    });
    listeners.get("SIGINT")?.();
    expect(kills).toEqual(["killed"]);
    // Exit is deferred so the SIGKILL follow-up timer can fire first.
    expect(exits).toEqual([]);
    expect(timers[0]?.ms).toBeGreaterThan(5_000);
    timers[0]?.fn();
    expect(exits).toEqual([0]);
  });

  it("exits immediately when no children are in flight", async () => {
    const timers: TimerCall[] = [];
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const { listeners, exits, processLike } = makeProcessLike();
    await runServer({
      server: makeStubServer(),
      logger: silentLogger,
      killInFlight: () => 0,
      processLike,
      createTransport: () => serverTransport,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
      }
    });
    listeners.get("SIGTERM")?.();
    expect(timers[0]?.ms).toBe(0);
    timers[0]?.fn();
    expect(exits).toEqual([0]);
  });

  it("only shuts down once even if multiple signals arrive", async () => {
    let killCount = 0;
    const timers: TimerCall[] = [];
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const { listeners, processLike } = makeProcessLike();
    await runServer({
      server: makeStubServer(),
      logger: silentLogger,
      killInFlight: () => {
        killCount += 1;
        return 0;
      },
      processLike,
      createTransport: () => serverTransport,
      setTimer: (fn) => timers.push({ fn, ms: 0 })
    });
    listeners.get("SIGINT")?.();
    listeners.get("SIGTERM")?.();
    expect(killCount).toBe(1);
  });

  it("kills in-flight children when the transport closes", async () => {
    const kills: string[] = [];
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { processLike } = makeProcessLike();
    await runServer({
      server: makeStubServer(),
      logger: silentLogger,
      killInFlight: () => {
        kills.push("killed");
        return 0;
      },
      processLike,
      createTransport: () => serverTransport,
      setTimer: (fn) => fn()
    });
    await clientTransport.start();
    await serverTransport.close();
    expect(kills).toEqual(["killed"]);
  });
});
