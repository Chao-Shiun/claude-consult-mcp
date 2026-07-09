import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { isClaudeConsultError, toDisplayText } from "./errors.js";
import { createDefaultRunner } from "./claude/runner.js";
import { createServer } from "./server/create-server.js";
import { runServer } from "./server/run-server.js";
import { dispatch } from "./dispatch.js";
import { runCommand } from "./run-command.js";
import { runSetup } from "./cli/setup.js";
import { createDefaultDoctorDeps, runDoctor } from "./cli/doctor.js";
import { createDefaultReviewGateDeps, runReviewGate } from "./cli/review-gate.js";

function printOut(line: string): void {
  process.stdout.write(`${line}\n`);
}

function printErr(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function serverMain(): Promise<number> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const runner = createDefaultRunner(config, logger);
  const server = createServer({ runClaude: runner.run, logger, ledger: runner.ledger, journal: runner.journal });
  await runServer({ server, logger, killInFlight: runner.killInFlight });
  return 0;
}

async function main(): Promise<void> {
  try {
    const code = await dispatch(process.argv.slice(2), {
      server: serverMain,
      setup: (args) => runSetup(args, { platform: process.platform, runCommand, print: printOut }),
      doctor: (args) => runDoctor(args, createDefaultDoctorDeps(printOut)),
      reviewGate: (args) => runReviewGate(args, createDefaultReviewGateDeps(printOut, printErr)),
      print: printOut
    });
    if (code !== 0) {
      process.exitCode = code;
    }
  } catch (error) {
    printErr(isClaudeConsultError(error) ? toDisplayText(error) : `unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

void main();
