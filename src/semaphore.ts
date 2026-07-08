import { ClaudeConsultError } from "./errors.js";

type Waiter = () => void;

export interface Semaphore {
  readonly withPermit: <T>(task: () => Promise<T> | T) => Promise<T>;
}

export function createSemaphore(permits: number): Semaphore {
  if (!Number.isInteger(permits) || permits < 1) {
    throw new ClaudeConsultError("INVALID_INPUT", `semaphore permits must be a positive integer, got ${permits}`, "use a permit count between 1 and 4");
  }

  let available = permits;
  let waiters: readonly Waiter[] = [];

  const acquire = (): Promise<void> => {
    if (available > 0) {
      available -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      waiters = [...waiters, resolve];
    });
  };

  const release = (): void => {
    const [next, ...rest] = waiters;
    if (next === undefined) {
      available += 1;
      return;
    }
    waiters = rest;
    next();
  };

  const withPermit = async <T>(task: () => Promise<T> | T): Promise<T> => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };

  return Object.freeze({ withPermit });
}
