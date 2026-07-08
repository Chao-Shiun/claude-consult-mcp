const VERSION = "0.1.0";

function main(argv: readonly string[]): void {
  const command = argv[0];
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  process.stderr.write(`claude-consult-mcp ${VERSION}: scaffold build, server not implemented yet\n`);
  process.exitCode = 1;
}

main(process.argv.slice(2));
