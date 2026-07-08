function deepFreeze<T>(value: T): T {
  // RegExp instances must stay unfrozen: zod's .regex() writes lastIndex during checks.
  if (value !== null && typeof value === "object" && !(value instanceof RegExp)) {
    for (const key of Object.getOwnPropertyNames(value)) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== null && typeof child === "object" && !Object.isFrozen(child)) {
        deepFreeze(child);
      }
    }
    Object.freeze(value);
  }
  return value;
}

export const VERSION = "0.1.0";
export const SERVER_NAME = "claude-consult-mcp";
export const CODEX_SERVER_ID = "claude-consult";
export const FOOTER_PREFIX = "[claude-consult]";
export const CHILD_ENV_MAX_THINKING_TOKENS = "MAX_THINKING_TOKENS";
export const FABLE_MODEL_MARKER = "fable";

export const ENV = deepFreeze({
  claudeBin: "CLAUDE_CONSULT_CLAUDE_BIN",
  timeoutMs: "CLAUDE_CONSULT_TIMEOUT_MS",
  model: "CLAUDE_CONSULT_MODEL",
  allowedModels: "CLAUDE_CONSULT_ALLOWED_MODELS",
  capability: "CLAUDE_CONSULT_CAPABILITY",
  allowedTools: "CLAUDE_CONSULT_ALLOWED_TOOLS",
  maxBudgetUsd: "CLAUDE_CONSULT_MAX_BUDGET_USD",
  maxThinkingTokens: "CLAUDE_CONSULT_MAX_THINKING_TOKENS",
  maxConcurrency: "CLAUDE_CONSULT_MAX_CONCURRENCY",
  logLevel: "CLAUDE_CONSULT_LOG_LEVEL",
  e2e: "CLAUDE_CONSULT_E2E"
});

export const CAPABILITIES = deepFreeze(["readonly", "research"] as const);
export type Capability = (typeof CAPABILITIES)[number];

export const LOG_LEVELS = deepFreeze(["silent", "error", "info", "debug"] as const);
export type LogLevel = (typeof LOG_LEVELS)[number];

export const EFFORT_LEVELS = deepFreeze(["low", "medium", "high", "xhigh", "max"] as const);
export type Effort = (typeof EFFORT_LEVELS)[number];

export const DEFAULTS = deepFreeze({
  timeoutMs: 600_000,
  model: "opus",
  capability: "research" as Capability,
  maxConcurrency: 2,
  logLevel: "info" as LogLevel
});

export const LIMITS = deepFreeze({
  timeoutMsMin: 5_000,
  timeoutMsMax: 1_200_000,
  concurrencyMin: 1,
  concurrencyMax: 4,
  promptMaxBytes: 400_000,
  stdoutMaxBytes: 10 * 1024 * 1024,
  stderrTailBytes: 64 * 1024,
  stderrSnippetChars: 2_000,
  stdoutSampleChars: 500,
  pathsMax: 32
});

export const CAPABILITY_TOOLS: Readonly<Record<Capability, readonly string[]>> = deepFreeze({
  readonly: ["Read", "Glob", "Grep"],
  research: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"]
});

export const FORBIDDEN_TOOLS = deepFreeze(["Write", "Edit", "NotebookEdit", "Bash"] as const);

export const PATTERNS = deepFreeze({
  sessionId: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  model: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
  toolToken: /^[A-Za-z][A-Za-z0-9_]*$/,
  // Two leading separators mark a Windows UNC path (\\host\share) or a device
  // path (\\.\, \\?\), or a POSIX //-prefixed path. Reading any of these can
  // force NTLM authentication to a remote host, so they are always rejected.
  uncOrDevice: /^[\\/]{2}/
});
