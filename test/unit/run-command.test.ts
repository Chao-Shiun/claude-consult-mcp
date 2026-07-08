import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../../src/run-command.js";

describe("runCommand", () => {
  it("runs a child process in the requested cwd", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "claude-consult-run-command-"));
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { cwd });

    expect(result.exitCode).toBe(0);
    expect(path.resolve(result.stdout)).toBe(path.resolve(cwd));
    expect(result.stderr).toBe("");
  });
});
