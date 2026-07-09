import { describe, expect, it } from "vitest";
import { dispatch, type Mains } from "../../src/dispatch.js";

function makeMains(): { calls: string[]; mains: Mains; lines: string[] } {
  const calls: string[] = [];
  const lines: string[] = [];
  return {
    calls,
    lines,
    mains: {
      server: async () => {
        calls.push("server");
        return 0;
      },
      setup: async (args) => {
        calls.push(`setup:${args.join(",")}`);
        return 0;
      },
      doctor: async (args) => {
        calls.push(`doctor:${args.join(",")}`);
        return 0;
      },
      reviewGate: async (args) => {
        calls.push(`review-gate:${args.join(",")}`);
        return 0;
      },
      print: (line: string) => {
        lines.push(line);
      }
    }
  };
}

describe("dispatch", () => {
  it("starts the MCP server when no arguments are given", async () => {
    const { calls, mains } = makeMains();
    await expect(dispatch([], mains)).resolves.toBe(0);
    expect(calls).toEqual(["server"]);
  });

  it("routes setup and doctor with their remaining arguments", async () => {
    const { calls, mains } = makeMains();
    await dispatch(["setup", "--model", "sonnet"], mains);
    await dispatch(["doctor", "--live"], mains);
    await dispatch(["review-gate", "--quiet"], mains);
    expect(calls).toEqual(["setup:--model,sonnet", "doctor:--live", "review-gate:--quiet"]);
  });

  it("prints the version for --version and -v", async () => {
    const { mains, lines } = makeMains();
    await expect(dispatch(["--version"], mains)).resolves.toBe(0);
    await expect(dispatch(["-v"], mains)).resolves.toBe(0);
    expect(lines).toEqual(["0.5.0", "0.5.0"]);
  });

  it("prints usage for --help and returns nonzero for unknown commands", async () => {
    const { mains, lines, calls } = makeMains();
    await expect(dispatch(["--help"], mains)).resolves.toBe(0);
    expect(lines.join("\n")).toContain("setup");
    expect(lines.join("\n")).toContain("doctor");
    expect(lines.join("\n")).toContain("review-gate");
    await expect(dispatch(["frobnicate"], mains)).resolves.toBe(1);
    expect(calls).toEqual([]);
  });
});
