import { SERVER_NAME, VERSION } from "./constants.js";

export interface Mains {
  readonly server: () => Promise<number>;
  readonly setup: (args: readonly string[]) => Promise<number>;
  readonly doctor: (args: readonly string[]) => Promise<number>;
  readonly reviewGate: (args: readonly string[]) => Promise<number>;
  readonly print: (line: string) => void;
}

const USAGE: readonly string[] = [
  `${SERVER_NAME} ${VERSION}`,
  "",
  "Usage:",
  `  ${SERVER_NAME}                 start the MCP stdio server (what Codex spawns)`,
  `  ${SERVER_NAME} setup [flags]   register this server with Codex (codex mcp add)`,
  "    --model <m> --capability <readonly|research> --allowed-models <a,b> --max-budget-usd <n>",
  `  ${SERVER_NAME} doctor [--live] check node/claude/codex/registration health`,
  `  ${SERVER_NAME} review-gate [--model <m>] [--max-diff-bytes <n>] [--quiet]`,
  `  ${SERVER_NAME} --version       print the version`
];

export async function dispatch(argv: readonly string[], mains: Mains): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined) {
    return mains.server();
  }
  if (command === "--version" || command === "-v") {
    mains.print(VERSION);
    return 0;
  }
  if (command === "--help" || command === "-h") {
    for (const line of USAGE) {
      mains.print(line);
    }
    return 0;
  }
  if (command === "setup") {
    return mains.setup(rest);
  }
  if (command === "doctor") {
    return mains.doctor(rest);
  }
  if (command === "review-gate") {
    return mains.reviewGate(rest);
  }
  for (const line of USAGE) {
    mains.print(line);
  }
  return 1;
}
