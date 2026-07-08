import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CODEX_SERVER_ID, SERVER_NAME } from "../constants.js";
import { loadConfig } from "../config.js";
import { isClaudeConsultError, toDisplayText } from "../errors.js";
import { createLogger } from "../logger.js";
import { createDefaultRunner } from "../claude/runner.js";
import { runCommand, type CommandResult } from "../run-command.js";

export interface LiveProbeResult {
  readonly ok: boolean;
  readonly detail: string;
}

export interface DoctorDeps {
  readonly platform: string;
  readonly nodeVersion: string;
  readonly runCommand: (command: string, args: readonly string[]) => Promise<CommandResult>;
  readonly readConfigToml: () => Promise<string | undefined>;
  readonly liveProbe: () => Promise<LiveProbeResult>;
  readonly print: (line: string) => void;
}

function extractSection(config: string, header: string): string {
  const start = config.indexOf(header);
  const rest = config.slice(start + header.length);
  const nextSection = rest.indexOf("\n[");
  return nextSection === -1 ? rest : rest.slice(0, nextSection);
}

export async function runDoctor(argv: readonly string[], deps: DoctorDeps): Promise<number> {
  const live = argv.includes("--live");
  let fails = 0;
  const ok = (message: string): void => deps.print(`[ok] ${message}`);
  const warn = (message: string): void => deps.print(`[warn] ${message}`);
  const fail = (message: string): void => {
    fails += 1;
    deps.print(`[fail] ${message}`);
  };

  const major = Number(deps.nodeVersion.replace(/^v/, "").split(".")[0]);
  if (Number.isFinite(major) && major >= 20) {
    ok(`node ${deps.nodeVersion}`);
  } else {
    fail(`node ${deps.nodeVersion} is below the required major version 20`);
  }

  try {
    const claude = await deps.runCommand("claude", ["--version"]);
    if (claude.exitCode === 0) {
      ok(`claude ${claude.stdout.trim()}`);
    } else {
      fail(`claude --version exited with ${claude.exitCode}: ${claude.stderr.trim()}`);
    }
  } catch {
    fail("claude CLI not found; install it with `npm install -g @anthropic-ai/claude-code` and run `claude` once to log in");
  }

  try {
    const codex = await deps.runCommand("codex", ["--version"]);
    if (codex.exitCode === 0) {
      ok(`codex ${codex.stdout.trim()}`);
    } else {
      fail(`codex --version exited with ${codex.exitCode}`);
    }
  } catch {
    fail("codex CLI not found; install it with `npm install -g @openai/codex`");
  }

  const config = await deps.readConfigToml();
  const header = `[mcp_servers.${CODEX_SERVER_ID}]`;
  if (config === undefined || !config.includes(header)) {
    warn(`not registered in ~/.codex/config.toml yet; run \`npx -y ${SERVER_NAME} setup\``);
  } else {
    ok("registered in ~/.codex/config.toml");
    if (deps.platform === "win32") {
      const section = extractSection(config, header);
      if (section.includes("npx") && !section.includes("\"cmd\"")) {
        warn("the Windows registration launches npx without the cmd /c wrapper; re-run setup or edit config.toml");
      }
    }
  }

  if (live) {
    const probe = await deps.liveProbe();
    if (probe.ok) {
      ok(`live probe: ${probe.detail}`);
    } else {
      fail(`live probe: ${probe.detail}`);
    }
  }

  return fails > 0 ? 1 : 0;
}

export function createDefaultDoctorDeps(print: (line: string) => void): DoctorDeps {
  return Object.freeze({
    platform: process.platform,
    nodeVersion: process.version,
    runCommand,
    readConfigToml: async () => {
      try {
        return await readFile(path.join(os.homedir(), ".codex", "config.toml"), "utf8");
      } catch {
        return undefined;
      }
    },
    liveProbe: async (): Promise<LiveProbeResult> => {
      try {
        const config = loadConfig();
        const logger = createLogger("silent");
        const runner = createDefaultRunner(config, logger);
        const envelope = await runner.run({ prompt: "Reply with exactly: ok" });
        return { ok: true, detail: `claude answered (session ${envelope.sessionId})` };
      } catch (error) {
        return { ok: false, detail: isClaudeConsultError(error) ? toDisplayText(error) : String(error) };
      }
    },
    print
  });
}
