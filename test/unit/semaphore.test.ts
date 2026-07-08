import { describe, expect, it } from "vitest";
import { isClaudeConsultError } from "../../src/errors.js";
import { createSemaphore } from "../../src/semaphore.js";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createSemaphore", () => {
  it("rejects non-positive or non-integer permit counts", () => {
    for (const permits of [0, -1, 1.5]) {
      try {
        createSemaphore(permits);
        expect.unreachable("expected createSemaphore to throw");
      } catch (error) {
        expect(isClaudeConsultError(error)).toBe(true);
        if (isClaudeConsultError(error)) {
          expect(error.code).toBe("INVALID_INPUT");
        }
      }
    }
  });

  it("limits concurrent tasks to the permit count", async () => {
    const semaphore = createSemaphore(2);
    let active = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const task = (): Promise<void> =>
      new Promise((resolve) => {
        active += 1;
        peak = Math.max(peak, active);
        gates.push(() => {
          active -= 1;
          resolve();
        });
      });
    const all = Promise.all([1, 2, 3, 4, 5].map(() => semaphore.withPermit(task)));
    await flush();
    expect(peak).toBe(2);
    while (gates.length > 0) {
      gates.shift()?.();
      await flush();
    }
    await all;
    expect(peak).toBe(2);
  });

  it("starts queued tasks in FIFO order", async () => {
    const semaphore = createSemaphore(1);
    const started: string[] = [];
    const gates: Array<() => void> = [];
    const make = (id: string) => (): Promise<void> =>
      new Promise((resolve) => {
        started.push(id);
        gates.push(resolve);
      });
    const all = Promise.all([make("a"), make("b"), make("c")].map((task) => semaphore.withPermit(task)));
    await flush();
    expect(started).toEqual(["a"]);
    gates.shift()?.();
    await flush();
    expect(started).toEqual(["a", "b"]);
    gates.shift()?.();
    await flush();
    expect(started).toEqual(["a", "b", "c"]);
    gates.shift()?.();
    await all;
  });

  it("releases the permit when a task throws", async () => {
    const semaphore = createSemaphore(1);
    await expect(semaphore.withPermit(() => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    await expect(semaphore.withPermit(() => "ok")).resolves.toBe("ok");
  });

  it("returns the task value and supports sync tasks", async () => {
    const semaphore = createSemaphore(2);
    await expect(semaphore.withPermit(() => Promise.resolve(42))).resolves.toBe(42);
    await expect(semaphore.withPermit(() => "sync")).resolves.toBe("sync");
  });
});
