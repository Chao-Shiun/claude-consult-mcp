import path from "node:path";
import { CAPABILITIES, CAPABILITY_TOOLS, DEFAULTS, EFFORT_LEVELS, ENV, FORBIDDEN_TOOLS, LIMITS, LOG_LEVELS, PATTERNS, type Capability, type Effort, type LogLevel } from "./constants.js";
import { ClaudeConsultError } from "./errors.js";

export interface Config {
  readonly claudeBin: string | undefined;
  readonly timeoutMs: number;
  readonly model: string | undefined;
  readonly allowedModels: readonly string[] | undefined;
  readonly capability: Capability;
  readonly allowedTools: readonly string[];
  readonly maxBudgetUsd: number | undefined;
  readonly maxThinkingTokens: number | undefined;
  readonly maxEffort: Effort | undefined;
  readonly journalDir: string | undefined;
  readonly maxConcurrency: number;
  readonly logLevel: LogLevel;
}

type Env = Readonly<Record<string, string | undefined>>;

function fail(name: string, detail: string, hint: string): never {
  throw new ClaudeConsultError("INVALID_INPUT", `environment variable ${name} ${detail}`, hint);
}

function readValue(env: Env, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseBoundedInt(env: Env, name: string, min: number, max: number, fallback: number): number {
  const raw = readValue(env, name);
  if (raw === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    fail(name, `must be an integer, got "${raw}"`, `set ${name} to an integer between ${min} and ${max}`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    fail(name, `must be between ${min} and ${max}, got ${value}`, `set ${name} within the allowed range or unset it for the default`);
  }
  return value;
}

function parsePositiveNumber(env: Env, name: string): number | undefined {
  const raw = readValue(env, name);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(value) || value <= 0) {
    fail(name, `must be a positive finite number, got "${raw}"`, `set ${name} to a positive number or unset it for no limit`);
  }
  return value;
}

function parsePositiveInt(env: Env, name: string): number | undefined {
  const raw = readValue(env, name);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isFinite(value) || value <= 0) {
    fail(name, `must be a positive finite integer, got "${raw}"`, `set ${name} to a positive integer or unset it for no limit`);
  }
  return value;
}

function parseChoice<T extends string>(env: Env, name: string, choices: readonly T[], fallback: T): T {
  const raw = readValue(env, name);
  if (raw === undefined) {
    return fallback;
  }
  if (!(choices as readonly string[]).includes(raw)) {
    fail(name, `must be one of ${choices.join(", ")}, got "${raw}"`, `set ${name} to one of the listed values or unset it for "${fallback}"`);
  }
  return raw as T;
}

function parseOptionalChoice<T extends string>(env: Env, name: string, choices: readonly T[]): T | undefined {
  const raw = readValue(env, name);
  if (raw === undefined) {
    return undefined;
  }
  if (!(choices as readonly string[]).includes(raw)) {
    fail(name, `must be one of ${choices.join(", ")}, got "${raw}"`, `set ${name} to one of ${choices.join(", ")} or unset it for no ceiling`);
  }
  return raw as T;
}

function parseList(env: Env, name: string, pattern: RegExp): readonly string[] | undefined {
  const raw = readValue(env, name);
  if (raw === undefined) {
    return undefined;
  }
  const tokens = raw.split(",").map((token) => token.trim());
  for (const token of tokens) {
    if (token === "" || !pattern.test(token)) {
      fail(name, `contains an invalid entry "${token}"`, `set ${name} to a comma-separated list matching ${pattern}`);
    }
  }
  return Object.freeze(tokens);
}

function parseModel(env: Env): string | undefined {
  const raw = env[ENV.model];
  if (raw === undefined) {
    return DEFAULTS.model;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (!PATTERNS.model.test(trimmed)) {
    fail(ENV.model, `must match ${PATTERNS.model}, got "${trimmed}"`, `set ${ENV.model} to a model alias like opus/sonnet/haiku or a full model id`);
  }
  return trimmed;
}

function parseAllowedTools(env: Env, capability: Capability): readonly string[] {
  const override = parseList(env, ENV.allowedTools, PATTERNS.toolToken);
  if (override === undefined) {
    return CAPABILITY_TOOLS[capability];
  }
  const forbidden = override.filter((token) => (FORBIDDEN_TOOLS as readonly string[]).includes(token));
  if (forbidden.length > 0) {
    fail(ENV.allowedTools, `must never contain write-capable tools, got: ${forbidden.join(", ")}`, "Claude is an advisor only; remove Write/Edit/NotebookEdit/Bash from the list");
  }
  return override;
}

function parseJournalDir(env: Env): string | undefined {
  const raw = readValue(env, ENV.journalDir);
  if (raw === undefined) {
    return undefined;
  }
  if (PATTERNS.uncOrDevice.test(raw) || !path.isAbsolute(raw)) {
    fail(ENV.journalDir, `must be a local absolute path, got "${raw}"`, "set it to a local directory path or unset it to disable journaling");
  }
  return raw;
}

export function loadConfig(env: Env = process.env): Config {
  const capability = parseChoice(env, ENV.capability, CAPABILITIES, DEFAULTS.capability);
  const model = parseModel(env);
  const allowedModels = parseList(env, ENV.allowedModels, PATTERNS.model);
  if (model !== undefined && allowedModels !== undefined && !allowedModels.includes(model)) {
    fail(ENV.model, `default model "${model}" is not in ${ENV.allowedModels} (${allowedModels.join(", ")})`, `add "${model}" to ${ENV.allowedModels} or change ${ENV.model}`);
  }
  return Object.freeze({
    claudeBin: readValue(env, ENV.claudeBin),
    timeoutMs: parseBoundedInt(env, ENV.timeoutMs, LIMITS.timeoutMsMin, LIMITS.timeoutMsMax, DEFAULTS.timeoutMs),
    model,
    allowedModels,
    capability,
    allowedTools: parseAllowedTools(env, capability),
    maxBudgetUsd: parsePositiveNumber(env, ENV.maxBudgetUsd),
    maxThinkingTokens: parsePositiveInt(env, ENV.maxThinkingTokens),
    maxEffort: parseOptionalChoice(env, ENV.maxEffort, EFFORT_LEVELS),
    journalDir: parseJournalDir(env),
    maxConcurrency: parseBoundedInt(env, ENV.maxConcurrency, LIMITS.concurrencyMin, LIMITS.concurrencyMax, DEFAULTS.maxConcurrency),
    logLevel: parseChoice(env, ENV.logLevel, LOG_LEVELS, DEFAULTS.logLevel)
  });
}
