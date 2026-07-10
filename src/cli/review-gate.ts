import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ENV, LIMITS, PATTERNS } from "../constants.js";
import { loadConfig } from "../config.js";
import { isClaudeConsultError } from "../errors.js";
import { createLogger } from "../logger.js";
import { runCommand, type CommandResult, type RunCommandOptions } from "../run-command.js";
import { createDefaultRunner, type RunClaude } from "../claude/runner.js";
import { composeAdvisorPrompt } from "../tools/advisor-prompt.js";

export const REVIEW_GATE_QUESTION = "This is an automatic post-turn review gate. In at most 10 bullet points, list only real problems in these changes - bugs, security issues, broken invariants - with file:line citations. If the changes look sound, reply with exactly: LGTM.";

export interface ReviewGateDeps {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runCommand: (command: string, args: readonly string[], options?: RunCommandOptions) => Promise<CommandResult>;
  readonly createRunner: (model: string) => RunClaude;
  readonly print: (line: string) => void;
  readonly printErr: (line: string) => void;
  readonly appendFindings?: ((record: string) => Promise<void>) | undefined;
  readonly readMemo?: (() => Promise<string | undefined>) | undefined;
  readonly writeMemo?: ((content: string) => Promise<void>) | undefined;
  readonly now?: (() => Date) | undefined;
}

interface ReviewGateOptions {
  readonly model: string | undefined;
  readonly maxDiffBytes: number;
  readonly quiet: boolean;
  readonly force: boolean;
}

interface CooldownMemoEntry {
  readonly hash: string;
  readonly at: string;
}

type CooldownMemo = Record<string, CooldownMemoEntry>;

const MEMO_MAX_ENTRIES = 20;
const SHA256_HEX = /^[a-f0-9]{64}$/;

function readEnv(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseArgs(argv: readonly string[]): ReviewGateOptions | string {
  let model: string | undefined;
  let maxDiffBytes = LIMITS.diffMaxBytes;
  let quiet = false;
  let force = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--quiet") {
      quiet = true;
      continue;
    }
    if (flag === "--force") {
      force = true;
      continue;
    }
    if (flag !== "--model" && flag !== "--max-diff-bytes") {
      return `unknown flag ${flag}; valid flags: --model, --max-diff-bytes, --quiet, --force`;
    }
    const value = argv[index + 1];
    if (value === undefined) {
      return `missing value for ${flag}`;
    }
    if (flag === "--model") {
      if (!PATTERNS.model.test(value)) {
        return `invalid model "${value}"`;
      }
      model = value;
      index += 1;
      continue;
    }
    if (flag === "--max-diff-bytes") {
      if (!/^\d+$/.test(value) || Number(value) <= 0) {
        return `invalid max-diff-bytes "${value}"`;
      }
      maxDiffBytes = Number(value);
      index += 1;
      continue;
    }
  }
  return { model, maxDiffBytes, quiet, force };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseMemo(content: string | undefined): CooldownMemo {
  if (content === undefined) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const entries = Object.entries(parsed);
    const valid = entries.every(([key, value]) => {
      if (!SHA256_HEX.test(key) || typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
      }
      const entry = value as Record<string, unknown>;
      return typeof entry.hash === "string" && SHA256_HEX.test(entry.hash) && typeof entry.at === "string" && !Number.isNaN(Date.parse(entry.at));
    });
    return valid ? Object.fromEntries(entries) as CooldownMemo : {};
  } catch {
    return {};
  }
}

async function readCooldownMemo(deps: ReviewGateDeps): Promise<CooldownMemo> {
  if (deps.readMemo === undefined) {
    return {};
  }
  try {
    return parseMemo(await deps.readMemo());
  } catch {
    return {};
  }
}

function upsertCooldownMemo(memo: CooldownMemo, repositoryKey: string, hash: string, at: string): CooldownMemo {
  return Object.fromEntries(Object.entries({ ...memo, [repositoryKey]: { hash, at } })
    .sort(([, left], [, right]) => right.at.localeCompare(left.at))
    .slice(0, MEMO_MAX_ENTRIES));
}

async function runGit(deps: ReviewGateDeps, args: readonly string[]): Promise<CommandResult> {
  return deps.runCommand("git", args, { cwd: deps.cwd });
}

function commandSucceeded(result: CommandResult): boolean {
  return result.exitCode === 0;
}

function skipped(deps: ReviewGateDeps, code: string): number {
  deps.printErr(`review-gate: skipped (${code})`);
  return 0;
}

function validLocalAbsolute(value: string): boolean {
  return path.isAbsolute(value) && !PATTERNS.uncOrDevice.test(value);
}

export function resolveGateLogPath(env: Readonly<Record<string, string | undefined>>, printErr: (line: string) => void): string | undefined {
  const gateLog = readEnv(env, ENV.gateLog);
  if (gateLog !== undefined) {
    if (!validLocalAbsolute(gateLog)) {
      printErr(`review-gate: findings log disabled (invalid ${ENV.gateLog})`);
      return undefined;
    }
    return gateLog;
  }
  const journalDir = readEnv(env, ENV.journalDir);
  if (journalDir !== undefined) {
    if (!validLocalAbsolute(journalDir)) {
      printErr(`review-gate: findings log disabled (invalid ${ENV.journalDir})`);
      return undefined;
    }
    return path.join(journalDir, "review-gate.log");
  }
  return undefined;
}

function composePrompt(diff: string, status: string): string {
  return `Review the following uncommitted code changes. You may Read the surrounding files in the repository for context before judging.\n\n<git-status>\n${status.trim() === "" ? "(clean)" : status.trim()}\n</git-status>\n\n<diff>\n${diff}\n</diff>\n\n<question>\n${REVIEW_GATE_QUESTION}\n</question>`;
}

export async function runReviewGate(argv: readonly string[], deps: ReviewGateDeps): Promise<number> {
  const parsed = parseArgs(argv);
  if (typeof parsed === "string") {
    return skipped(deps, `INVALID_INPUT: ${parsed}`);
  }

  let insideWorkTree: CommandResult;
  try {
    insideWorkTree = await runGit(deps, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return skipped(deps, "GIT_UNAVAILABLE");
  }
  if (!commandSucceeded(insideWorkTree) || !insideWorkTree.stdout.includes("true")) {
    return 0;
  }

  let diff: CommandResult;
  let status: CommandResult;
  try {
    diff = await runGit(deps, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "HEAD"]);
    status = await runGit(deps, ["status", "--porcelain"]);
  } catch {
    return skipped(deps, "GIT_UNAVAILABLE");
  }
  if (!commandSucceeded(diff) || !commandSucceeded(status)) {
    return skipped(deps, "GIT_COMMAND_FAILED");
  }
  if (diff.stdout.trim() === "" && status.stdout.trim() === "") {
    return 0;
  }

  const diffBytes = Buffer.byteLength(diff.stdout, "utf8");
  if (diffBytes > parsed.maxDiffBytes) {
    deps.printErr(`review-gate: diff too large (${diffBytes} bytes), skipped`);
    return 0;
  }

  const repositoryKey = sha256(deps.cwd);
  const reviewedContentHash = sha256(`${deps.cwd}\0${diff.stdout}\0${status.stdout}`);
  const memo = await readCooldownMemo(deps);
  if (!parsed.force && memo[repositoryKey]?.hash === reviewedContentHash) {
    deps.printErr("review-gate: diff unchanged since last review, skipped");
    return 0;
  }

  const model = parsed.model ?? readEnv(deps.env, ENV.gateModel) ?? "haiku";
  try {
    const runClaude = deps.createRunner(model);
    const envelope = await runClaude({
      prompt: composePrompt(diff.stdout, status.stdout),
      appendSystemPrompt: composeAdvisorPrompt(),
      addDirs: [deps.cwd],
      cwd: deps.cwd,
      model,
      origin: { tool: "review-gate", excerpt: "automatic post-turn diff review", excerptFromResult: true }
    });
    const answer = envelope.result.trim();
    const reviewedAt = (deps.now ?? (() => new Date()))().toISOString();
    if (deps.appendFindings !== undefined) {
      try {
        await deps.appendFindings(`## ${reviewedAt} | model: ${model} | session_id: ${envelope.sessionId}\n${answer}\n\n`);
      } catch {
        deps.printErr("review-gate: findings log unavailable");
      }
    }
    if (deps.writeMemo !== undefined) {
      try {
        await deps.writeMemo(JSON.stringify(upsertCooldownMemo(memo, repositoryKey, reviewedContentHash, reviewedAt)));
      } catch {
        deps.printErr("review-gate: cooldown memo unavailable");
      }
    }
    if (parsed.quiet && answer === "LGTM") {
      return 0;
    }
    deps.print(`claude-consult review-gate:\n${answer}`);
    return 0;
  } catch (error) {
    return skipped(deps, isClaudeConsultError(error) ? error.code : "INTERNAL_ERROR");
  }
}

export function createDefaultReviewGateDeps(print: (line: string) => void, printErr: (line: string) => void): ReviewGateDeps {
  const gateLogPath = resolveGateLogPath(process.env, printErr);
  const memoPath = gateLogPath === undefined ? undefined : path.join(path.dirname(gateLogPath), "review-gate.state.json");
  const appendFindings = gateLogPath === undefined
    ? undefined
    : async (record: string): Promise<void> => {
      await mkdir(path.dirname(gateLogPath), { recursive: true });
      await appendFile(gateLogPath, record, "utf8");
    };
  const readMemo = memoPath === undefined
    ? undefined
    : async (): Promise<string | undefined> => {
      try {
        return await readFile(memoPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    };
  const writeMemo = memoPath === undefined
    ? undefined
    : async (content: string): Promise<void> => {
      await mkdir(path.dirname(memoPath), { recursive: true });
      await writeFile(memoPath, content, "utf8");
    };
  const journalDir = readEnv(process.env, ENV.journalDir);
  const runnerEnv = journalDir !== undefined && !validLocalAbsolute(journalDir)
    ? { ...process.env, [ENV.journalDir]: undefined }
    : process.env;
  return Object.freeze({
    cwd: process.cwd(),
    env: process.env,
    runCommand,
    createRunner: (model: string) => {
      const config = loadConfig({ ...runnerEnv, [ENV.model]: model });
      const logger = createLogger(config.logLevel);
      return createDefaultRunner(config, logger).run;
    },
    print,
    printErr,
    appendFindings,
    readMemo,
    writeMemo
  });
}
