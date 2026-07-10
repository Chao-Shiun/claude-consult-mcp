import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "../../src/constants.js";
import { parseStopHookClaim, startClaimRead } from "../../src/cli/stop-hook-claim.js";
import { truncateToBytes } from "../../src/tools/exhibits.js";

const CWD = process.platform === "win32" ? "C:\\repo" : "/repo";
const OTHER_CWD = process.platform === "win32" ? "C:\\other" : "/other";

function pipe(): PassThrough & { isTTY?: boolean } {
  const stream = new PassThrough() as PassThrough & { isTTY?: boolean };
  Object.defineProperty(stream, "isTTY", { value: undefined, configurable: true });
  return stream;
}

function payload(message: unknown = "implemented validation", cwd: unknown = CWD, event: unknown = "Stop"): string {
  return JSON.stringify({ hook_event_name: event, cwd, last_assistant_message: message });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("stop-hook claim input", () => {
  it("starts reading eagerly before the returned await function is called", async () => {
    const stdin = pipe();
    const read = startClaimRead(stdin);

    stdin.end(payload());

    await expect(read()).resolves.toBe(payload());
  });

  it("returns immediately for a TTY stdin", async () => {
    const stdin = pipe();
    Object.defineProperty(stdin, "isTTY", { value: true });

    await expect(startClaimRead(stdin)()).resolves.toBeUndefined();
    expect(stdin.listenerCount("data")).toBe(0);
  });

  it("treats an undefined isTTY pipe as readable and bounds a silent pipe by the deadline", async () => {
    vi.useFakeTimers();
    const stdin = pipe();
    const pending = startClaimRead(stdin)();

    await vi.advanceTimersByTimeAsync(LIMITS.gateStdinTimeoutMs);

    await expect(pending).resolves.toBeUndefined();
  });

  it("returns undefined for EOF without data", async () => {
    const stdin = pipe();
    const read = startClaimRead(stdin);
    stdin.end();

    await expect(read()).resolves.toBeUndefined();
  });

  it("discards an oversized raw payload without rejecting", async () => {
    const stdin = pipe();
    const read = startClaimRead(stdin);
    stdin.end("x".repeat(LIMITS.gateStdinMaxBytes + 1));

    await expect(read()).resolves.toBeUndefined();
  });

  it("never rejects when stdin emits an error", async () => {
    const stdin = pipe();
    const read = startClaimRead(stdin);
    stdin.emit("error", new Error("broken pipe"));

    await expect(read()).resolves.toBeUndefined();
  });

  it("parses a valid Stop payload", () => {
    expect(parseStopHookClaim(payload(), CWD)).toBe("implemented validation");
  });

  it.each([
    ["missing input", undefined],
    ["empty input", ""],
    ["malformed JSON", "{"],
    ["non-object JSON", "[]"],
    ["wrong hook event", payload("implemented validation", CWD, "PreToolUse")],
    ["mismatched cwd", payload("implemented validation", OTHER_CWD)],
    ["missing message", JSON.stringify({ hook_event_name: "Stop", cwd: CWD })],
    ["non-string message", payload(42)],
    ["whitespace-only message", payload("  \n\t")]
  ])("returns undefined for %s", (_label, raw) => {
    expect(parseStopHookClaim(raw, CWD)).toBeUndefined();
  });

  it("allows a payload without cwd", () => {
    expect(parseStopHookClaim(JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "claim" }), CWD)).toBe("claim");
  });

  it.skipIf(process.platform !== "win32")("compares Windows cwd values case-insensitively", () => {
    expect(parseStopHookClaim(payload("claim", "c:\\REPO"), "C:\\repo")).toBe("claim");
  });

  it("compares resolved cwd values", () => {
    expect(parseStopHookClaim(payload("claim", path.join(CWD, ".")), CWD)).toBe("claim");
  });

  it("truncates long UTF-8 claims safely and appends the marker", () => {
    const message = "😀".repeat(LIMITS.gateClaimMaxBytes);
    const claim = parseStopHookClaim(payload(message), CWD);

    expect(claim).toBe(`${truncateToBytes(message, LIMITS.gateClaimMaxBytes)}\n(truncated)`);
    expect(Buffer.byteLength(claim?.replace("\n(truncated)", "") ?? "", "utf8")).toBeLessThanOrEqual(LIMITS.gateClaimMaxBytes);
  });
});
