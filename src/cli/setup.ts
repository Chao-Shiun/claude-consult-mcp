import { CAPABILITIES, CODEX_SERVER_ID, ENV, PATTERNS, SERVER_NAME } from "../constants.js";
import type { CommandResult } from "./run-command.js";

export interface SetupDeps {
  readonly platform: string;
  readonly runCommand: (command: string, args: readonly string[]) => Promise<CommandResult>;
  readonly print: (line: string) => void;
}

interface SetupOptions {
  readonly model: string | undefined;
  readonly capability: string | undefined;
  readonly allowedModels: string | undefined;
  readonly maxBudgetUsd: string | undefined;
}

function parseSetupArgs(argv: readonly string[]): SetupOptions | string {
  let model: string | undefined;
  let capability: string | undefined;
  let allowedModels: string | undefined;
  let maxBudgetUsd: string | undefined;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
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
        break;
      case "--capability":
        if (!(CAPABILITIES as readonly string[]).includes(value)) {
          return `invalid capability "${value}"; use one of ${CAPABILITIES.join(", ")}`;
        }
        capability = value;
        break;
      case "--allowed-models":
        if (value.split(",").some((token) => !PATTERNS.model.test(token.trim()))) {
          return `invalid allowed-models list "${value}"`;
        }
        allowedModels = value;
        break;
      case "--max-budget-usd":
        if (!/^\d+(\.\d+)?$/.test(value) || Number(value) <= 0) {
          return `invalid max-budget-usd "${value}"`;
        }
        maxBudgetUsd = value;
        break;
      default:
        return `unknown flag ${flag}; valid flags: --model, --capability, --allowed-models, --max-budget-usd`;
    }
  }
  return { model, capability, allowedModels, maxBudgetUsd };
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

export async function runSetup(argv: readonly string[], deps: SetupDeps): Promise<number> {
  const parsed = parseSetupArgs(argv);
  if (typeof parsed === "string") {
    deps.print(`Invalid arguments: ${parsed}`);
    return 1;
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
