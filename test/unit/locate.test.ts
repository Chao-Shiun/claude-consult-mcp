import { describe, expect, it } from "vitest";
import { isClaudeConsultError } from "../../src/errors.js";
import { createClaudeLocator } from "../../src/claude/locate.js";

function fakeFs(paths: readonly string[]): { calls: string[]; fileExists: (filePath: string) => Promise<boolean> } {
  const existing = new Set(paths);
  const calls: string[] = [];
  return {
    calls,
    fileExists: async (filePath: string) => {
      calls.push(filePath);
      return existing.has(filePath);
    }
  };
}

async function expectNotFound(locate: () => Promise<string>, messagePart: string): Promise<void> {
  try {
    await locate();
    expect.unreachable("expected locate to throw");
  } catch (error) {
    expect(isClaudeConsultError(error)).toBe(true);
    if (isClaudeConsultError(error)) {
      expect(error.code).toBe("CLAUDE_NOT_FOUND");
      expect(`${error.message} ${error.hint}`).toContain(messagePart);
    }
  }
}

describe("createClaudeLocator", () => {
  it("returns the configured binary when it exists", async () => {
    const fs = fakeFs(["C:\\tools\\claude.exe"]);
    const locator = createClaudeLocator({ claudeBin: "C:\\tools\\claude.exe", platform: "win32", pathValue: "C:\\ignored", pathExtValue: undefined, fileExists: fs.fileExists });
    await expect(locator.locate()).resolves.toBe("C:\\tools\\claude.exe");
  });

  it("fails fast when the configured binary is missing", async () => {
    const fs = fakeFs([]);
    const locator = createClaudeLocator({ claudeBin: "C:\\tools\\claude.exe", platform: "win32", pathValue: "C:\\real", pathExtValue: undefined, fileExists: fs.fileExists });
    await expectNotFound(locator.locate, "CLAUDE_CONSULT_CLAUDE_BIN");
  });

  it("scans PATH with PATHEXT candidates on Windows", async () => {
    const fs = fakeFs(["C:\\nodejs\\claude.CMD"]);
    const locator = createClaudeLocator({ claudeBin: undefined, platform: "win32", pathValue: "C:\\a;C:\\nodejs", pathExtValue: ".COM;.EXE;.BAT;.CMD", fileExists: fs.fileExists });
    await expect(locator.locate()).resolves.toBe("C:\\nodejs\\claude.CMD");
  });

  it("prefers the earliest PATH entry", async () => {
    const fs = fakeFs(["C:\\first\\claude.cmd", "C:\\second\\claude.exe"]);
    const locator = createClaudeLocator({ claudeBin: undefined, platform: "win32", pathValue: "C:\\first;C:\\second", pathExtValue: ".COM;.EXE;.BAT;.CMD", fileExists: fs.fileExists });
    await expect(locator.locate()).resolves.toBe("C:\\first\\claude.cmd");
  });

  it("applies the default PATHEXT set when the variable is missing", async () => {
    const fs = fakeFs(["C:\\x\\claude.exe"]);
    const locator = createClaudeLocator({ claudeBin: undefined, platform: "win32", pathValue: "C:\\x", pathExtValue: undefined, fileExists: fs.fileExists });
    await expect(locator.locate()).resolves.toBe("C:\\x\\claude.exe");
  });

  it("scans PATH with the bare name on POSIX", async () => {
    const fs = fakeFs(["/usr/bin/claude"]);
    const locator = createClaudeLocator({ claudeBin: undefined, platform: "darwin", pathValue: "/usr/local/bin:/usr/bin", pathExtValue: undefined, fileExists: fs.fileExists });
    await expect(locator.locate()).resolves.toBe("/usr/bin/claude");
  });

  it("throws an actionable CLAUDE_NOT_FOUND when nothing matches", async () => {
    const fs = fakeFs([]);
    const locator = createClaudeLocator({ claudeBin: undefined, platform: "darwin", pathValue: "/usr/bin", pathExtValue: undefined, fileExists: fs.fileExists });
    await expectNotFound(locator.locate, "npm install -g @anthropic-ai/claude-code");
  });

  it("handles an empty PATH", async () => {
    const fs = fakeFs([]);
    const locator = createClaudeLocator({ claudeBin: undefined, platform: "darwin", pathValue: undefined, pathExtValue: undefined, fileExists: fs.fileExists });
    await expectNotFound(locator.locate, "CLAUDE_CONSULT_CLAUDE_BIN");
  });

  it("memoizes a successful resolution", async () => {
    const fs = fakeFs(["/usr/bin/claude"]);
    const locator = createClaudeLocator({ claudeBin: undefined, platform: "darwin", pathValue: "/usr/bin", pathExtValue: undefined, fileExists: fs.fileExists });
    await locator.locate();
    const callsAfterFirst = fs.calls.length;
    await locator.locate();
    expect(fs.calls.length).toBe(callsAfterFirst);
  });
});
