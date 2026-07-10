import os from "node:os";
import { CAPABILITY_TOOLS, CHILD_ENV_MAX_THINKING_TOKENS, LIMITS, type Effort } from "../constants.js";
import { ClaudeConsultError } from "../errors.js";
import type { Config } from "../config.js";
import { createJournal, type Journal } from "../journal.js";
import type { Logger } from "../logger.js";
import { createSemaphore } from "../semaphore.js";
import { createSessionLedger, type SessionLedger } from "../session-ledger.js";
import { buildClaudeArgs, resolveRunPolicy } from "./build-args.js";
import { createDefaultClaudeLocator } from "./locate.js";
import { parseClaudeOutput, type ClaudeEnvelope, type RawRunOutput } from "./parse-output.js";
import { createDefaultSpawnDeps, spawnClaude, type SpawnClaudeRequest } from "./spawn-claude.js";

export interface RunnerRequest {
  readonly prompt: string;
  readonly model?: string | undefined;
  readonly effort?: Effort | undefined;
  readonly sessionId?: string | undefined;
  readonly appendSystemPrompt?: string | undefined;
  readonly jsonSchema?: string | undefined;
  readonly addDirs?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly depth?: "standard" | "deep" | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly origin?: { readonly tool: string; readonly excerpt: string; readonly excerptFromResult?: boolean } | undefined;
}

export type RunClaude = (request: RunnerRequest) => Promise<ClaudeEnvelope>;

export interface Runner {
  readonly run: RunClaude;
  readonly killInFlight: () => number;
  readonly ledger: SessionLedger;
  readonly journal?: Journal | undefined;
}

export interface RunnerDeps {
  readonly config: Config;
  readonly logger: Logger;
  readonly locate: () => Promise<string>;
  readonly spawnImpl: (request: SpawnClaudeRequest, onSpawned: (kill: () => void) => () => void) => Promise<RawRunOutput>;
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  readonly defaultCwd: string;
  readonly ledger?: SessionLedger | undefined;
  readonly journal?: Journal | undefined;
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

const DEEP_RESEARCH_GUIDANCE = "You may delegate read-only exploration to sub-agents to cover large scopes, then synthesize their findings yourself.";

function resolveAllowedTools(config: Config, depth: RunnerRequest["depth"]): readonly string[] {
  if (depth === "deep" && config.capability !== "deep-research") {
    throw new ClaudeConsultError("INVALID_INPUT", "deep analysis requires CLAUDE_CONSULT_CAPABILITY=deep-research on this machine", "unset depth or ask the repository owner to enable the deep-research capability tier");
  }
  if (depth === "deep") {
    return CAPABILITY_TOOLS["deep-research"];
  }
  if (config.capability === "deep-research" && config.allowedTools === CAPABILITY_TOOLS["deep-research"]) {
    return CAPABILITY_TOOLS.research;
  }
  return config.allowedTools;
}

function applyDepthGuidance(prompt: string, depth: RunnerRequest["depth"]): string {
  return depth === "deep" ? `${prompt}\n\n${DEEP_RESEARCH_GUIDANCE}` : prompt;
}

function cancellationError(): ClaudeConsultError {
  return new ClaudeConsultError("REQUEST_CANCELLED", "the tool call was cancelled by the caller before claude finished", "no action needed; re-issue the call if the cancellation was accidental");
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw cancellationError();
  }
}

export function createRunner(deps: RunnerDeps): Runner {
  const semaphore = createSemaphore(deps.config.maxConcurrency);
  const inFlight = new Set<() => void>();
  const ledger = deps.ledger ?? createSessionLedger();
  const journal = deps.journal;

  const registerChild = (kill: () => void): (() => void) => {
    inFlight.add(kill);
    return () => {
      inFlight.delete(kill);
    };
  };

  const run = async (request: RunnerRequest): Promise<ClaudeEnvelope> => {
    throwIfCancelled(request.signal);
    const prompt = applyDepthGuidance(request.prompt, request.depth);
    validatePrompt(prompt);
    const allowedTools = resolveAllowedTools(deps.config, request.depth);
    const policy = resolveRunPolicy(deps.config, { model: request.model, effort: request.effort });
    const args = buildClaudeArgs({
      allowedTools,
      model: policy.model,
      effort: policy.effort,
      sessionId: request.sessionId,
      appendSystemPrompt: request.appendSystemPrompt,
      jsonSchema: request.jsonSchema,
      budgetUsd: policy.budgetUsd,
      addDirs: request.addDirs ?? []
    });
    const binPath = await deps.locate();
    const env = deps.config.maxThinkingTokens === undefined
      ? deps.baseEnv
      : Object.freeze({ ...deps.baseEnv, [CHILD_ENV_MAX_THINKING_TOKENS]: String(deps.config.maxThinkingTokens) });
    const cwd = request.cwd ?? deps.defaultCwd;
    deps.logger.info(`running claude (model: ${policy.model ?? "cli-default"}, cwd: ${cwd})`);
    let abortListener: (() => void) | undefined;
    const removeAbortListener = (): void => {
      if (abortListener !== undefined) {
        request.signal?.removeEventListener("abort", abortListener);
        abortListener = undefined;
      }
    };
    const registerAbortableChild = (kill: () => void): (() => void) => {
      const unregisterChild = registerChild(kill);
      if (request.signal !== undefined) {
        abortListener = () => kill();
        request.signal.addEventListener("abort", abortListener, { once: true });
        if (request.signal.aborted) {
          kill();
        }
      }
      return () => {
        removeAbortListener();
        unregisterChild();
      };
    };
    const raw = await semaphore.withPermit(async () => {
      throwIfCancelled(request.signal);
      try {
        const result = await deps.spawnImpl({
          binPath,
          args,
          prompt,
          cwd,
          env,
          timeoutMs: deps.config.timeoutMs
        }, registerAbortableChild);
        throwIfCancelled(request.signal);
        return result;
      } finally {
        removeAbortListener();
      }
    });
    const envelope = parseClaudeOutput(raw);
    if (request.origin !== undefined) {
      const resultExcerpt = envelope.result.split(/\r?\n/).find((line) => line.trim() !== "");
      const excerpt = request.origin.excerptFromResult === true && resultExcerpt !== undefined ? resultExcerpt : request.origin.excerpt;
      ledger.record({ sessionId: envelope.sessionId, tool: request.origin.tool, workspaceDir: request.cwd, model: request.model, excerpt });
      void journal?.append({
        ts: new Date().toISOString(),
        sessionId: envelope.sessionId,
        tool: request.origin.tool,
        workspaceDir: request.cwd,
        model: request.model,
        excerpt,
        costUsd: envelope.totalCostUsd,
        durationMs: envelope.durationMs
      }).catch((error: unknown) => {
        deps.logger.error(`failed to append consultation journal: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    return envelope;
  };

  const killInFlight = (): number => {
    const pending = [...inFlight];
    for (const kill of pending) {
      kill();
    }
    return pending.length;
  };

  return Object.freeze({ run, killInFlight, ledger, journal });
}

export function createDefaultRunner(config: Config, logger: Logger): Runner {
  const locator = createDefaultClaudeLocator(config);
  const ledger = createSessionLedger();
  const journal = config.journalDir === undefined ? undefined : createJournal(config.journalDir, logger);
  return createRunner({
    config,
    logger,
    locate: locator.locate,
    spawnImpl: (request, onSpawned) => spawnClaude(request, createDefaultSpawnDeps(logger, onSpawned)),
    baseEnv: process.env,
    defaultCwd: os.homedir(),
    ledger,
    journal
  });
}
