import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS } from "../../src/constants.js";
import { createExhibitBudget, extractFileExhibit } from "../../src/tools/exhibits.js";

async function makeWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "ccm-exhibits-"));
}

describe("neutral exhibit extraction", () => {
  it("extracts cited lines with five lines of context and line numbers", async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, "src", "example.ts");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"), "utf8");

    const exhibit = await extractFileExhibit({
      workspaceDir: workspace,
      ref: "src/example.ts:10-11",
      budget: createExhibitBudget()
    });

    expect(exhibit.ref).toBe("src/example.ts:10-11");
    expect(exhibit.content).toContain("5: line 5");
    expect(exhibit.content).toContain("10: line 10");
    expect(exhibit.content).toContain("11: line 11");
    expect(exhibit.content).toContain("16: line 16");
    expect(exhibit.content).not.toContain("4: line 4");
    expect(exhibit.content).not.toContain("17: line 17");
  });

  it("rejects path escapes, outside absolute paths, and UNC/device refs without reading them", async () => {
    const workspace = await makeWorkspace();
    const outside = path.join(os.tmpdir(), `ccm-outside-${process.pid}.txt`);
    await writeFile(outside, "outside secret", "utf8");
    const budget = createExhibitBudget();

    const parentEscape = await extractFileExhibit({ workspaceDir: workspace, ref: "..\\escape.txt", budget });
    const outsideAbsolute = await extractFileExhibit({ workspaceDir: workspace, ref: outside, budget });
    const unc = await extractFileExhibit({ workspaceDir: workspace, ref: "\\\\attacker\\share\\secret.txt", budget });

    expect(parentEscape.content).toMatch(/^\(exhibit unavailable: /);
    expect(outsideAbsolute.content).toMatch(/^\(exhibit unavailable: /);
    expect(unc.content).toMatch(/^\(exhibit unavailable: /);
    expect(outsideAbsolute.content).not.toContain("outside secret");
  });

  it("enforces the shared exhibit byte cap across extractions", async () => {
    const workspace = await makeWorkspace();
    const first = path.join(workspace, "first.txt");
    const second = path.join(workspace, "second.txt");
    await writeFile(first, "a".repeat(40_000), "utf8");
    await writeFile(second, "b".repeat(40_000), "utf8");
    const budget = createExhibitBudget();

    const exhibitA = await extractFileExhibit({ workspaceDir: workspace, ref: "first.txt", budget });
    const exhibitB = await extractFileExhibit({ workspaceDir: workspace, ref: "second.txt", budget });
    const totalBytes = Buffer.byteLength(exhibitA.content, "utf8") + Buffer.byteLength(exhibitB.content, "utf8");

    expect(LIMITS.exhibitMaxBytes).toBe(65_536);
    expect(totalBytes).toBeLessThanOrEqual(LIMITS.exhibitMaxBytes);
    expect(exhibitA.content).toContain("a");
    expect(exhibitB.content).toContain("b");
  });

  it("does not exceed the byte cap when truncating multibyte UTF-8 characters", async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, "emoji.txt");
    await writeFile(file, "😀".repeat(20_000), "utf8");

    const exhibit = await extractFileExhibit({
      workspaceDir: workspace,
      ref: "emoji.txt",
      budget: createExhibitBudget()
    });

    expect(Buffer.byteLength(exhibit.content, "utf8")).toBeLessThanOrEqual(LIMITS.exhibitMaxBytes);
    expect(exhibit.content).not.toContain("�");
  });
});
