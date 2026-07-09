import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CAPABILITIES, CODEX_SERVER_ID, ENV, PATTERNS, SERVER_NAME } from "../constants.js";
import type { CommandResult } from "../run-command.js";

export interface SetupDeps {
  readonly platform: string;
  readonly runCommand: (command: string, args: readonly string[]) => Promise<CommandResult>;
  readonly print: (line: string) => void;
  readonly homeDir?: string | undefined;
  readonly now?: (() => Date) | undefined;
}

interface SetupOptions {
  readonly model: string | undefined;
  readonly capability: string | undefined;
  readonly allowedModels: string | undefined;
  readonly maxBudgetUsd: string | undefined;
  readonly reviewGateAction: "install" | "remove" | undefined;
  readonly gateLog: string | undefined;
  readonly journalDir: string | undefined;
}

function parseSetupArgs(argv: readonly string[]): SetupOptions | string {
  let model: string | undefined;
  let capability: string | undefined;
  let allowedModels: string | undefined;
  let maxBudgetUsd: string | undefined;
  let reviewGateAction: "install" | "remove" | undefined;
  let gateLog: string | undefined;
  let journalDir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--install-review-gate" || flag === "--remove-review-gate") {
      const action = flag === "--install-review-gate" ? "install" : "remove";
      if (reviewGateAction !== undefined) {
        return "choose only one of --install-review-gate or --remove-review-gate";
      }
      reviewGateAction = action;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) {
      return `missing value for ${flag}`;
    }
    switch (flag) {
      case "--model":
        if (!PATTERNS.model.test(value)) {
          return `invalid model "${value}"`;
        }
        model = value;
        index += 1;
        break;
      case "--capability":
        if (!(CAPABILITIES as readonly string[]).includes(value)) {
          return `invalid capability "${value}"; use one of ${CAPABILITIES.join(", ")}`;
        }
        capability = value;
        index += 1;
        break;
      case "--allowed-models":
        if (value.split(",").some((token) => !PATTERNS.model.test(token.trim()))) {
          return `invalid allowed-models list "${value}"`;
        }
        allowedModels = value;
        index += 1;
        break;
      case "--max-budget-usd":
        if (!/^\d+(\.\d+)?$/.test(value) || Number(value) <= 0) {
          return `invalid max-budget-usd "${value}"`;
        }
        maxBudgetUsd = value;
        index += 1;
        break;
      case "--gate-log":
        gateLog = value;
        index += 1;
        break;
      case "--journal-dir":
        journalDir = value;
        index += 1;
        break;
      default:
        return `unknown flag ${flag}; valid flags: --model, --capability, --allowed-models, --max-budget-usd, --install-review-gate, --remove-review-gate, --gate-log, --journal-dir`;
    }
  }
  if (reviewGateAction !== undefined && [model, capability, allowedModels, maxBudgetUsd].some((value) => value !== undefined)) {
    return "--install-review-gate and --remove-review-gate cannot be combined with MCP registration flags";
  }
  if (reviewGateAction === undefined && (gateLog !== undefined || journalDir !== undefined)) {
    return "--gate-log and --journal-dir require --install-review-gate";
  }
  if (reviewGateAction === "remove" && (gateLog !== undefined || journalDir !== undefined)) {
    return "--remove-review-gate cannot be combined with --gate-log or --journal-dir";
  }
  return { model, capability, allowedModels, maxBudgetUsd, reviewGateAction, gateLog, journalDir };
}

function buildEnvPairs(options: SetupOptions): readonly string[] {
  const pairs: string[] = [];
  if (options.model !== undefined) {
    pairs.push("--env", `${ENV.model}=${options.model}`);
  }
  if (options.capability !== undefined) {
    pairs.push("--env", `${ENV.capability}=${options.capability}`);
  }
  if (options.allowedModels !== undefined) {
    pairs.push("--env", `${ENV.allowedModels}=${options.allowedModels}`);
  }
  if (options.maxBudgetUsd !== undefined) {
    pairs.push("--env", `${ENV.maxBudgetUsd}=${options.maxBudgetUsd}`);
  }
  return pairs;
}

function timestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validLocalAbsolute(value: string): boolean {
  return path.isAbsolute(value) && !PATTERNS.uncOrDevice.test(value);
}

function validateReviewGatePath(name: string, value: string | undefined): string | undefined {
  if (value !== undefined && !validLocalAbsolute(value)) {
    return `${name} must be a local absolute path, got "${value}"`;
  }
  return undefined;
}

function quotePosixEnvValue(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function commandFor(platform: string, options: Pick<SetupOptions, "gateLog" | "journalDir">): string {
  const vars: Array<readonly [string, string]> = [];
  if (options.gateLog !== undefined) {
    vars.push([ENV.gateLog, options.gateLog]);
  }
  if (options.journalDir !== undefined) {
    vars.push([ENV.journalDir, options.journalDir]);
  }
  if (platform === "win32") {
    const envPrefix = vars.map(([name, value]) => `set "${name}=${value}" && `).join("");
    return `cmd /c ${envPrefix}npx -y ${SERVER_NAME} review-gate`;
  }
  const envPrefix = vars.length === 0 ? "" : `env ${vars.map(([name, value]) => `${name}=${quotePosixEnvValue(value)}`).join(" ")} `;
  return `${envPrefix}npx -y ${SERVER_NAME} review-gate`;
}

function isReviewGateHook(value: unknown): boolean {
  return isObject(value) && typeof value.command === "string" && value.command.includes(`${SERVER_NAME} review-gate`);
}

function getHooksObject(root: Record<string, unknown>): Record<string, unknown> | string {
  if (root.hooks === undefined) {
    root.hooks = {};
  }
  if (!isObject(root.hooks)) {
    return "hooks.json field \"hooks\" must be an object";
  }
  return root.hooks;
}

function readStopGroups(hooks: Record<string, unknown>): unknown[] | string {
  if (hooks.Stop === undefined) {
    hooks.Stop = [];
  }
  if (!Array.isArray(hooks.Stop)) {
    return "hooks.json field hooks.Stop must be an array";
  }
  return hooks.Stop;
}

function removeReviewGateCommands(stopGroups: unknown[]): number {
  let removed = 0;
  for (const group of stopGroups) {
    if (!isObject(group) || !Array.isArray(group.hooks)) {
      continue;
    }
    const groupHooks = group.hooks;
    const filtered = groupHooks.filter((hook) => !isReviewGateHook(hook));
    group.hooks = filtered;
    removed += groupHooks.length - filtered.length;
  }
  return removed;
}

function installReviewGateCommand(root: Record<string, unknown>, platform: string, options: Pick<SetupOptions, "gateLog" | "journalDir">): string | undefined {
  const hooks = getHooksObject(root);
  if (typeof hooks === "string") {
    return hooks;
  }
  const stopGroups = readStopGroups(hooks);
  if (typeof stopGroups === "string") {
    return stopGroups;
  }
  removeReviewGateCommands(stopGroups);
  const existingGroup = stopGroups.find((group) => isObject(group) && group.matcher === "" && Array.isArray(group.hooks));
  const hook = { type: "command", command: commandFor(platform, options) };
  if (isObject(existingGroup) && Array.isArray(existingGroup.hooks)) {
    existingGroup.hooks.push(hook);
  } else {
    stopGroups.push({ matcher: "", hooks: [hook] });
  }
  return undefined;
}

function removeReviewGateCommand(root: Record<string, unknown>): string | undefined {
  const hooks = getHooksObject(root);
  if (typeof hooks === "string") {
    return hooks;
  }
  const stopGroups = readStopGroups(hooks);
  if (typeof stopGroups === "string") {
    return stopGroups;
  }
  removeReviewGateCommands(stopGroups);
  hooks.Stop = stopGroups.filter((group) => !(isObject(group) && Array.isArray(group.hooks) && group.hooks.length === 0));
  return undefined;
}

async function readHooksFile(hooksPath: string): Promise<{ readonly root: Record<string, unknown>; readonly existed: boolean } | string> {
  let text: string;
  try {
    text = await readFile(hooksPath, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return { root: { hooks: {} }, existed: false };
    }
    return `Cannot read ${hooksPath}: ${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isObject(parsed)) {
      return "Cannot parse hooks.json: root must be an object";
    }
    return { root: parsed, existed: true };
  } catch (error) {
    return `Cannot parse hooks.json: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function writeHooksFile(root: Record<string, unknown>, hooksPath: string, existed: boolean, deps: SetupDeps): Promise<void> {
  const codexDir = path.dirname(hooksPath);
  await mkdir(codexDir, { recursive: true });
  if (existed) {
    await copyFile(hooksPath, path.join(codexDir, `hooks.json.bak-${timestamp((deps.now ?? (() => new Date()))())}`));
  }
  await writeFile(hooksPath, `${JSON.stringify(root, null, 2)}\n`, { encoding: "utf8" });
}

async function runReviewGateSetup(options: SetupOptions, deps: SetupDeps): Promise<number> {
  const action = options.reviewGateAction;
  if (action === undefined) {
    return 1;
  }
  for (const error of [validateReviewGatePath(ENV.gateLog, options.gateLog), validateReviewGatePath(ENV.journalDir, options.journalDir)]) {
    if (error !== undefined) {
      deps.print(`Invalid arguments: ${error}`);
      return 1;
    }
  }
  const hooksPath = path.join(deps.homeDir ?? os.homedir(), ".codex", "hooks.json");
  const loaded = await readHooksFile(hooksPath);
  if (typeof loaded === "string") {
    deps.print(loaded);
    return 1;
  }
  const mutationError = action === "install"
    ? installReviewGateCommand(loaded.root, deps.platform, options)
    : removeReviewGateCommand(loaded.root);
  if (mutationError !== undefined) {
    deps.print(mutationError);
    return 1;
  }
  await writeHooksFile(loaded.root, hooksPath, loaded.existed, deps);
  if (action === "install") {
    deps.print("Installed the review gate as a Codex stop hook. Codex will ask you to trust the new hook on first use; the gate reviews uncommitted changes after each turn and stays silent when everything looks sound. Remove it anytime with: npx -y claude-consult-mcp setup --remove-review-gate");
    if (options.gateLog === undefined && options.journalDir === undefined) {
      deps.print("Review-gate findings will only be durable if Codex already passes CLAUDE_CONSULT_GATE_LOG or CLAUDE_CONSULT_JOURNAL_DIR to hooks; prefer setup --install-review-gate --gate-log <absolute-path>.");
    }
  } else {
    deps.print("Removed the review gate Codex stop hook.");
  }
  return 0;
}

export async function runSetup(argv: readonly string[], deps: SetupDeps): Promise<number> {
  const parsed = parseSetupArgs(argv);
  if (typeof parsed === "string") {
    deps.print(`Invalid arguments: ${parsed}`);
    return 1;
  }
  if (parsed.reviewGateAction !== undefined) {
    return runReviewGateSetup(parsed, deps);
  }
  const launcher = deps.platform === "win32" ? ["cmd", "/c", "npx", "-y", SERVER_NAME] : ["npx", "-y", SERVER_NAME];
  const args = ["mcp", "add", CODEX_SERVER_ID, ...buildEnvPairs(parsed), "--", ...launcher];

  let result: CommandResult;
  try {
    result = await deps.runCommand("codex", args);
  } catch {
    deps.print("Codex CLI not found. Install it with `npm install -g @openai/codex` and re-run setup.");
    return 1;
  }

  if (result.exitCode !== 0) {
    const combined = `${result.stdout}\n${result.stderr}`;
    if (/already exists/i.test(combined)) {
      deps.print(`An MCP server named "${CODEX_SERVER_ID}" already exists. Remove it with \`codex mcp remove ${CODEX_SERVER_ID}\` and re-run setup.`);
    } else {
      deps.print(`codex mcp add failed (exit ${result.exitCode}):`);
      deps.print(combined.trim());
    }
    return 1;
  }

  deps.print(`Registered MCP server "${CODEX_SERVER_ID}" with Codex.`);
  deps.print("");
  deps.print("Recommended: add these lines under the server section in ~/.codex/config.toml");
  deps.print("(codex mcp add has no flags for them):");
  deps.print("");
  deps.print(`[mcp_servers.${CODEX_SERVER_ID}]`);
  deps.print("startup_timeout_sec = 60");
  deps.print("tool_timeout_sec = 600");
  deps.print("");
  deps.print("Restart the Codex desktop app to pick up the new server.");
  return 0;
}
