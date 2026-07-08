import { FOOTER_PREFIX, type LogLevel } from "./constants.js";

export interface LogSink {
  write(chunk: string): unknown;
}

export interface Logger {
  readonly error: (message: string) => void;
  readonly info: (message: string) => void;
  readonly debug: (message: string) => void;
}

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = Object.freeze({
  silent: 0,
  error: 1,
  info: 2,
  debug: 3
});

export function createLogger(level: LogLevel, sink: LogSink = process.stderr): Logger {
  const activeRank = LEVEL_RANK[level];
  const emit = (rank: number, label: string, message: string): void => {
    if (activeRank >= rank) {
      sink.write(`${FOOTER_PREFIX} [${label}] ${message}\n`);
    }
  };
  return Object.freeze({
    error: (message: string) => emit(LEVEL_RANK.error, "error", message),
    info: (message: string) => emit(LEVEL_RANK.info, "info", message),
    debug: (message: string) => emit(LEVEL_RANK.debug, "debug", message)
  });
}
