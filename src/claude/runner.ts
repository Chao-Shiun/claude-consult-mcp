import os from "node:os";
import { CHILD_ENV_MAX_THINKING_TOKENS, LIMITS } from "../constants.js";
import { ClaudeConsultError } from "../errors.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { createSemaphore } from "../semaphore.js";
import { buildClaudeArgs, resolveRunPolicy } from "./build-args.js";
import { createDefaultClaudeLocator } from "./locate.js";
import { parseClaudeOutput, type ClaudeEnvelope, type RawRunOutput } from "./parse-output.js";
import { createDefaultSpawnDeps, spawnClaude, type SpawnClaudeRequest } from "./spawn-claude.js";

export interface RunnerRequest {
  readonly prompt: string;
  readonly model?: string | undefined;
  readonly budgetUsd?: number | undefined;
  readonly sessionId?: string | undefined;
  readonly appendSystemPrompt?: string | undefined;
  readonly addDirs?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
}

export type RunClaude = (request: RunnerRequest) => Promise<ClaudeEnvelope>;

export interface Runner {
  readonly run: RunClaude;
  readonly killInFlight: () => void;
}

export interface RunnerDeps {
  readonly config: Config;
  readonly logger: Logger;
  readonly locate: () => Promise<string>;
  readonly spawnImpl: (request: SpawnClaudeRequest, onSpawned: (kill: () => void) => () => void) => Promise<RawRunOutput>;
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  readonly defaultCwd: string;
}

function validatePrompt(prompt: string): void {
  if (prompt.trim() === "") {
    throw new ClaudeConsultError("INVALID_INPUT", "prompt must not be empty", "provide the question or message text");
  }
  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes > LIMITS.promptMaxBytes) {
    throw new ClaudeConsultError("INVALID_INPUT", `prompt is ${bytes} bytes which exceeds the ${LIMITS.promptMaxBytes} byte limit`, "shorten the prompt or point Claude at files with claude_review_files instead of pasting content");
  }
}

export function createRunner(deps: RunnerDeps): Runner {
  const semaphore = createSemaphore(deps.config.maxConcurrency);
  const inFlight = new Set<() => void>();

  const registerChild = (kill: () => void): (() => void) => {
    inFlight.add(kill);
    return () => {
      inFlight.delete(kill);
    };
  };

  const run = async (request: RunnerRequest): Promise<ClaudeEnvelope> => {
    validatePrompt(request.prompt);
    const policy = resolveRunPolicy(deps.config, { model: request.model, budgetUsd: request.budgetUsd });
    const args = buildClaudeArgs({
      allowedTools: deps.config.allowedTools,
      model: policy.model,
      effort: policy.effort,
      sessionId: request.sessionId,
      appendSystemPrompt: request.appendSystemPrompt,
      budgetUsd: policy.budgetUsd,
      addDirs: request.addDirs ?? []
    });
    const binPath = await deps.locate();
    const env = deps.config.maxThinkingTokens === undefined
      ? deps.baseEnv
      : Object.freeze({ ...deps.baseEnv, [CHILD_ENV_MAX_THINKING_TOKENS]: String(deps.config.maxThinkingTokens) });
    const cwd = request.cwd ?? deps.defaultCwd;
    deps.logger.info(`running claude (model: ${policy.model ?? "cli-default"}, cwd: ${cwd})`);
    const raw = await semaphore.withPermit(() => deps.spawnImpl({
      binPath,
      args,
      prompt: request.prompt,
      cwd,
      env,
      timeoutMs: deps.config.timeoutMs
    }, registerChild));
    return parseClaudeOutput(raw);
  };

  const killInFlight = (): void => {
    for (const kill of [...inFlight]) {
      kill();
    }
  };

  return Object.freeze({ run, killInFlight });
}

export function createDefaultRunner(config: Config, logger: Logger): Runner {
  const locator = createDefaultClaudeLocator(config);
  return createRunner({
    config,
    logger,
    locate: locator.locate,
    spawnImpl: (request, onSpawned) => spawnClaude(request, createDefaultSpawnDeps(logger, onSpawned)),
    baseEnv: process.env,
    defaultCwd: os.homedir()
  });
}
