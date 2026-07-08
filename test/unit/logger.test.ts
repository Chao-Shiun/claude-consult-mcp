import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/logger.js";

function createSink(): { lines: string[]; write: (chunk: string) => boolean } {
  const lines: string[] = [];
  return {
    lines,
    write: (chunk: string) => {
      lines.push(chunk);
      return true;
    }
  };
}

describe("logger", () => {
  it("writes nothing at silent level", () => {
    const sink = createSink();
    const logger = createLogger("silent", sink);
    logger.error("e");
    logger.info("i");
    logger.debug("d");
    expect(sink.lines).toEqual([]);
  });

  it("writes only errors at error level", () => {
    const sink = createSink();
    const logger = createLogger("error", sink);
    logger.error("boom");
    logger.info("i");
    logger.debug("d");
    expect(sink.lines).toEqual(["[claude-consult] [error] boom\n"]);
  });

  it("writes error and info at info level", () => {
    const sink = createSink();
    const logger = createLogger("info", sink);
    logger.error("boom");
    logger.info("hello");
    logger.debug("d");
    expect(sink.lines).toEqual(["[claude-consult] [error] boom\n", "[claude-consult] [info] hello\n"]);
  });

  it("writes everything at debug level", () => {
    const sink = createSink();
    const logger = createLogger("debug", sink);
    logger.error("e");
    logger.info("i");
    logger.debug("d");
    expect(sink.lines).toEqual(["[claude-consult] [error] e\n", "[claude-consult] [info] i\n", "[claude-consult] [debug] d\n"]);
  });

  it("returns a frozen logger and defaults its sink safely", () => {
    const logger = createLogger("silent");
    expect(Object.isFrozen(logger)).toBe(true);
    expect(() => logger.debug("no-op")).not.toThrow();
  });
});
