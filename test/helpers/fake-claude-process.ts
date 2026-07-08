import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

export class FakeClaudeProcess extends EventEmitter {
  readonly pid: number | undefined;
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  stdinData = "";
  stdinEnded = false;

  constructor(pid: number | undefined = 4321) {
    super();
    this.pid = pid;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin.on("data", (chunk: Buffer | string) => {
      this.stdinData = `${this.stdinData}${String(chunk)}`;
    });
    this.stdin.on("finish", () => {
      this.stdinEnded = true;
    });
  }

  emitStdout(text: string | Buffer): void {
    this.stdout.write(text);
  }

  emitStderr(text: string): void {
    this.stderr.write(text);
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }

  failSpawn(error: Error): void {
    this.emit("error", error);
  }
}
