import { z } from "zod";
import { toDisplayText, toInternalError } from "../errors.js";
import { composeAdvisorPrompt } from "./advisor-prompt.js";
import { analyzePaths, type PathAnalysis } from "./path-analysis.js";
import { commonToolShape, pathsSchema, promptTextSchema, type ConsultTool, type ToolContext, type ToolExecuteExtra } from "./shared-schemas.js";
import { formatFooter, type ToolResult } from "./tool-result.js";

export const PANEL_PERSPECTIVES = ["correctness", "security", "performance", "simplicity", "architecture", "testing"] as const;

type PanelPerspective = (typeof PANEL_PERSPECTIVES)[number];

const DEFAULT_PERSPECTIVES: readonly PanelPerspective[] = Object.freeze(["correctness", "security", "simplicity"]);

const LENS_PROMPTS: Readonly<Record<PanelPerspective, string>> = Object.freeze({
  correctness: "You are the correctness reviewer on a multi-perspective panel. Verify the technical claims and hunt for logic errors, boundary conditions, off-by-one mistakes, race conditions, and unhandled failure paths. State concrete failure scenarios, not general worries.",
  security: "You are the security reviewer on a multi-perspective panel. Look for injection surfaces, authentication and authorization gaps, secret handling problems, path traversal, SSRF, unsafe deserialization, and supply-chain risks. Rate each finding by exploitability and impact.",
  performance: "You are the performance reviewer on a multi-perspective panel. Examine algorithmic complexity, unnecessary allocations, N+1 IO patterns, blocking calls, cache behavior, and scalability limits. Quantify where possible.",
  simplicity: "You are the simplicity reviewer on a multi-perspective panel. Find over-engineering, speculative generality, and needless indirection; propose the simplest design that still meets the requirements. Point out what could be deleted.",
  architecture: "You are the architecture reviewer on a multi-perspective panel. Assess module boundaries, coupling and cohesion, dependency direction, failure isolation, and how the design will evolve under new requirements.",
  testing: "You are the testing reviewer on a multi-perspective panel. Identify untested behaviors, missing edge-case and error-path coverage, brittle or tautological tests, and concrete test cases worth adding."
});

const perspectivesSchema = z.array(z.enum(PANEL_PERSPECTIVES)).min(1).max(4)
  .refine((values) => new Set(values).size === values.length, { message: "perspectives must not contain duplicates" });

const argsSchema = z.object({
  task: promptTextSchema,
  context: promptTextSchema.optional(),
  paths: pathsSchema.optional(),
  perspectives: perspectivesSchema.optional(),
  workspace_dir: commonToolShape.workspace_dir,
  model: commonToolShape.model,
  effort: commonToolShape.effort
});

const DESCRIPTION = "Run a multi-perspective Claude review panel in ONE call: several independent Claude analyses of the same task, each through a different expert lens (correctness, security, performance, simplicity, architecture, testing), returned as one aggregated report. Use this when the user asks for verification or review from multiple perspectives or with sub-agents - Claude acts as an independent cross-model panel alongside your own work. Each perspective is a separate full Claude run, so usage and latency scale with the number of perspectives (they run concurrently). Provide absolute paths when the panel should read code from disk. Claude only advises; it never modifies files.";

function buildPanelPrompt(task: string, context: string | undefined, analysis: PathAnalysis | undefined): string {
  const parts = [
    "A multi-perspective review panel has been convened. You are one panel member; your lens is defined in your system prompt.",
    "",
    "<task>",
    task,
    "</task>"
  ];
  if (context !== undefined) {
    parts.push("", "<background-context>", context, "</background-context>");
  }
  if (analysis !== undefined) {
    parts.push("", "Read and analyze the following paths from disk before answering. Use your Read, Glob, and Grep tools within the granted directories.", "", "Paths:", analysis.pathList);
  }
  parts.push("", "Answer strictly from your assigned lens.");
  return parts.join("\n");
}

export function createPanelTool(toolContext: ToolContext): ConsultTool {
  return Object.freeze({
    name: "claude_panel",
    title: "Claude Panel",
    description: DESCRIPTION,
    inputSchema: {
      task: promptTextSchema.describe("What the panel should analyze."),
      context: promptTextSchema.optional().describe("Background context for every panelist."),
      paths: pathsSchema.optional().describe("Absolute paths of files or directories every panelist should read (1-32)."),
      perspectives: perspectivesSchema.optional().describe("Fixed expert lenses to run, defaulting to correctness, security, and simplicity."),
      workspace_dir: commonToolShape.workspace_dir,
      model: commonToolShape.model,
      effort: commonToolShape.effort
    },
    execute: async (rawArgs: Record<string, unknown>, extra?: ToolExecuteExtra): Promise<ToolResult> => {
      const args = argsSchema.parse(rawArgs);
      const perspectives = args.perspectives ?? DEFAULT_PERSPECTIVES;
      const analysis = args.paths === undefined ? undefined : await analyzePaths(args.paths, args.workspace_dir);
      const prompt = buildPanelPrompt(args.task, args.context, analysis);
      const settled = await Promise.allSettled(perspectives.map((perspective) => toolContext.runClaude({
        prompt,
        appendSystemPrompt: composeAdvisorPrompt(LENS_PROMPTS[perspective]),
        addDirs: analysis?.dirs ?? [],
        cwd: analysis?.cwd ?? args.workspace_dir,
        model: args.model,
        effort: args.effort,
        signal: extra?.signal,
        origin: { tool: "claude_panel", excerpt: args.task }
      })));
      const sections = perspectives.map((perspective, index) => {
        const result = settled[index];
        if (result?.status === "fulfilled") {
          return `## Perspective: ${perspective}\n\n${result.value.result}\n\n${formatFooter(result.value)}`;
        }
        return `## Perspective: ${perspective} (FAILED)\n\n${toDisplayText(toInternalError(result?.reason))}`;
      });
      const allFailed = settled.every((result) => result.status === "rejected");
      return { content: [{ type: "text", text: `# Claude panel: ${perspectives.length} perspective(s)\n\n${sections.join("\n\n")}` }], ...(allFailed ? { isError: true } : {}) };
    }
  });
}
