import { z } from "zod";
import { composeAdvisorPrompt } from "./advisor-prompt.js";
import { createExhibitBudget, extractFileExhibit, type NeutralExhibit } from "./exhibits.js";
import { CRITICAL_REVIEWER_PROMPT } from "./second-opinion.js";
import { absolutePathSchema, modelSchema, promptTextSchema, sessionIdSchema, type ConsultTool, type ToolContext, type ToolExecuteExtra } from "./shared-schemas.js";
import { STRUCTURED_FORMAT_DESCRIPTION, toSuccessResult } from "./tool-result.js";

const EVIDENCE_TYPES = ["file", "url", "command_output", "reasoning"] as const;
const REPLY_ACTIONS = ["accept", "rebut"] as const;

type EvidenceType = (typeof EVIDENCE_TYPES)[number];
type ReplyAction = (typeof REPLY_ACTIONS)[number];

export const DEBATE_REFEREE_PROMPT = "This is a formal evidence debate. Rules: every position you take must cite evidence you verified yourself; label every caller claim verified, refuted, or cannot_verify; if you concede a point, name the exact evidence that persuaded you; do not soften findings to be agreeable. Keep disputes open rather than manufacturing consensus.";

export const DEBATE_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    claim_verifications: { type: "array", items: { type: "object", properties: {
      item_id: { type: "string" }, status: { type: "string", enum: ["verified", "refuted", "cannot_verify"] }, evidence: { type: "string" }
    }, required: ["item_id", "status", "evidence"] } },
    counter_claims: { type: "array", items: { type: "object", properties: {
      statement: { type: "string" }, evidence: { type: "string" }
    }, required: ["statement", "evidence"] } },
    concessions: { type: "array", items: { type: "string" } },
    remaining_disputes: { type: "array", items: { type: "string" } },
    verdict: { type: "string", enum: ["agree", "partial", "disagree", "contested"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    summary_markdown: { type: "string" }
  },
  required: ["claim_verifications", "counter_claims", "concessions", "remaining_disputes", "verdict", "confidence", "summary_markdown"]
});

const OPEN_DESCRIPTION = `Open a structured, evidence-based debate with Claude about a significant decision. Bring your position and your evidence (file references, URLs, command outputs). Claude will independently verify every verifiable item - reading the files and fetching the URLs itself - then return per-claim rulings and counter-claims with its own evidence. Expensive and slow (an agentic verification run); use it for architecture decisions, risky changes, and security-sensitive work, not routine questions. Continue rounds with claude_debate_reply. Claude only advises; it never modifies anything. ${STRUCTURED_FORMAT_DESCRIPTION}`;

const REPLY_DESCRIPTION = `Continue an open evidence debate. For each of Claude's counter-claims or rulings, either accept it (name it) or rebut it with an argument and new evidence. You are expected to have verified Claude's cited evidence yourself before rebutting. Rounds should converge: stop when remaining_disputes is empty or after three rounds, and report the per-claim outcome to the user. ${STRUCTURED_FORMAT_DESCRIPTION}`;

const evidenceItemSchema = z.object({
  claim: promptTextSchema,
  type: z.enum(EVIDENCE_TYPES),
  ref: z.string().min(1).max(512),
  content: z.string().max(20_000).optional()
});

const evidenceArraySchema = z.array(evidenceItemSchema).min(1).max(20);

const openArgsSchema = z.object({
  topic: promptTextSchema,
  position: promptTextSchema,
  evidence: evidenceArraySchema,
  workspace_dir: absolutePathSchema,
  model: modelSchema.optional()
});

const replyArgsSchema = z.object({
  session_id: sessionIdSchema,
  workspace_dir: absolutePathSchema,
  responses: z.array(z.object({
    item: z.string().max(200),
    action: z.enum(REPLY_ACTIONS),
    argument: promptTextSchema,
    evidence: evidenceItemSchema.optional()
  })).min(1).max(20),
  model: modelSchema.optional()
});

type EvidenceItem = z.infer<typeof evidenceItemSchema>;

interface DebateExhibit extends NeutralExhibit {
  readonly forItem: string;
}

function itemTag(id: string, evidence: EvidenceItem): string {
  const lines = [
    `<item id="${id}" type="${evidence.type}" ref="${evidence.ref}">`,
    "<claim>",
    evidence.claim,
    "</claim>"
  ];
  if (evidence.content !== undefined) {
    lines.push("<content>", evidence.content, "</content>");
  }
  lines.push("</item>");
  return lines.join("\n");
}

async function collectNeutralExhibits(workspaceDir: string, items: readonly { readonly id: string; readonly evidence: EvidenceItem }[]): Promise<readonly DebateExhibit[]> {
  const budget = createExhibitBudget();
  const exhibits: DebateExhibit[] = [];
  for (const item of items) {
    if (item.evidence.type === "file") {
      const exhibit = await extractFileExhibit({ workspaceDir, ref: item.evidence.ref, budget });
      exhibits.push(Object.freeze({ ref: exhibit.ref, content: exhibit.content, forItem: item.id }));
    }
  }
  return Object.freeze(exhibits);
}

function exhibitTag(exhibit: NeutralExhibit, forItem: string): string {
  return `<exhibit for-item="${forItem}" ref="${exhibit.ref}">${exhibit.content}</exhibit>`;
}

function renderOpenPrompt(args: z.infer<typeof openArgsSchema>, exhibits: readonly DebateExhibit[]): string {
  const evidenceItems = args.evidence.map((evidence, index) => itemTag(String(index + 1), evidence)).join("\n");
  const exhibitItems = exhibits.map((exhibit) => exhibitTag(exhibit, exhibit.forItem)).join("\n");
  return [
    "A structured evidence debate has been opened. Verify before you judge.",
    "",
    "<topic>",
    args.topic,
    "</topic>",
    "<caller-position>",
    args.position,
    "</caller-position>",
    "<caller-evidence>",
    evidenceItems,
    "</caller-evidence>",
    "<neutral-exhibits>",
    exhibitItems,
    "</neutral-exhibits>",
    "",
    "Independently verify each item you can (read the files yourself, fetch the URLs). command_output items: you cannot re-run commands; judge their plausibility against the code and mark them cannot_verify unless contradicted by what you read."
  ].join("\n");
}

function renderReplyPrompt(args: z.infer<typeof replyArgsSchema>, exhibits: readonly DebateExhibit[]): string {
  const responses = args.responses.map((response, responseIndex) => {
    const parts = [
      `<round-response item="${response.item}" action="${response.action}">`,
      "<argument>",
      response.argument,
      "</argument>"
    ];
    if (response.evidence !== undefined) {
      parts.push("<new-evidence>", itemTag(`${responseIndex + 1}.1`, response.evidence), "</new-evidence>");
    }
    parts.push("</round-response>");
    return parts.join("\n");
  }).join("\n");
  const exhibitItems = exhibits.map((exhibit) => exhibitTag(exhibit, exhibit.forItem)).join("\n");
  return [
    "A structured evidence debate round continues. Verify before you judge.",
    "",
    "<round-responses>",
    responses,
    "</round-responses>",
    "<neutral-exhibits>",
    exhibitItems,
    "</neutral-exhibits>",
    "",
    "Independently verify each new item you can. command_output items: you cannot re-run commands; judge their plausibility against the code and mark them cannot_verify unless contradicted by what you read."
  ].join("\n");
}

function refereePrompt(): string {
  return composeAdvisorPrompt(`${CRITICAL_REVIEWER_PROMPT} ${DEBATE_REFEREE_PROMPT}`);
}

export function createDebateOpenTool(toolContext: ToolContext): ConsultTool {
  return Object.freeze({
    name: "claude_debate_open",
    title: "Claude Debate Open",
    description: OPEN_DESCRIPTION,
    inputSchema: {
      topic: promptTextSchema.describe("The decision or claim to debate."),
      position: promptTextSchema.describe("Your current position or recommendation."),
      evidence: evidenceArraySchema.describe("Evidence items supporting your position."),
      workspace_dir: absolutePathSchema.describe("Absolute path to the project this debate is about; becomes Claude's working directory."),
      model: modelSchema.optional().describe("Claude model override: opus, sonnet, haiku, or a full model id. Omit for the configured default.")
    },
    execute: async (rawArgs: Record<string, unknown>, extra?: ToolExecuteExtra) => {
      const args = openArgsSchema.parse(rawArgs);
      const exhibits = await collectNeutralExhibits(args.workspace_dir, args.evidence.map((evidence, index) => ({ id: String(index + 1), evidence })));
      return toSuccessResult(await toolContext.runClaude({
        prompt: renderOpenPrompt(args, exhibits),
        appendSystemPrompt: refereePrompt(),
        jsonSchema: DEBATE_JSON_SCHEMA,
        addDirs: [args.workspace_dir],
        cwd: args.workspace_dir,
        model: args.model,
        signal: extra?.signal
      }), { structuredExpected: true });
    }
  });
}

export function createDebateReplyTool(toolContext: ToolContext): ConsultTool {
  return Object.freeze({
    name: "claude_debate_reply",
    title: "Claude Debate Reply",
    description: REPLY_DESCRIPTION,
    inputSchema: {
      session_id: sessionIdSchema.describe("session_id from claude_debate_open or the previous debate round."),
      workspace_dir: absolutePathSchema.describe("Absolute path to the same project used by the open debate call."),
      responses: replyArgsSchema.shape.responses.describe("Accept or rebut Claude's prior claims."),
      model: modelSchema.optional().describe("Claude model override: opus, sonnet, haiku, or a full model id. Omit for the configured default.")
    },
    execute: async (rawArgs: Record<string, unknown>, extra?: ToolExecuteExtra) => {
      const args = replyArgsSchema.parse(rawArgs);
      const evidence = args.responses.flatMap((response, index) => response.evidence === undefined ? [] : [{ id: `${index + 1}.1`, evidence: response.evidence }]);
      const exhibits = await collectNeutralExhibits(args.workspace_dir, evidence);
      return toSuccessResult(await toolContext.runClaude({
        prompt: renderReplyPrompt(args, exhibits),
        appendSystemPrompt: refereePrompt(),
        jsonSchema: DEBATE_JSON_SCHEMA,
        addDirs: [args.workspace_dir],
        cwd: args.workspace_dir,
        model: args.model,
        sessionId: args.session_id,
        signal: extra?.signal
      }), { structuredExpected: true });
    }
  });
}
