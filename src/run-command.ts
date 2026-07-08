import crossSpawn from "cross-spawn";

export interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunCommandOptions {
  readonly cwd?: string;
}

export function runCommand(command: string, args: readonly string[], options: RunCommandOptions = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = crossSpawn(command, [...args], { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = `${stdout}${String(chunk)}`;
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${String(chunk)}`;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code, stdout, stderr }));
  });
}
