import path from "node:path";
import { EFFORT_LEVELS, ENV, FABLE_MODEL_MARKER, FORBIDDEN_TOOLS, PATTERNS } from "../constants.js";
import { ClaudeConsultError } from "../errors.js";
import type { Config } from "../config.js";

export interface RunPolicyRequest {
  readonly model?: string | undefined;
}

export interface RunPolicy {
  readonly model: string | undefined;
  readonly effort: string | undefined;
  readonly budgetUsd: number | undefined;
}

export interface RunSpec {
  readonly allowedTools: readonly string[];
  readonly model: string | undefined;
  readonly effort: string | undefined;
  readonly sessionId: string | undefined;
  readonly appendSystemPrompt: string | undefined;
  readonly budgetUsd: number | undefined;
  readonly addDirs: readonly string[];
}

function invalid(message: string, hint: string): never {
  throw new ClaudeConsultError("INVALID_INPUT", message, hint);
}

export function isFableModel(model: string | undefined): boolean {
  return model !== undefined && model.toLowerCase().includes(FABLE_MODEL_MARKER);
}

export function resolveRunPolicy(config: Config, request: RunPolicyRequest): RunPolicy {
  if (request.model !== undefined && !PATTERNS.model.test(request.model)) {
    invalid(`requested model "${request.model}" does not match the safe model pattern`, "use an alias like opus/sonnet/haiku or a full model id");
  }
  const model = request.model ?? config.model;
  if (model !== undefined && config.allowedModels !== undefined && !config.allowedModels.includes(model)) {
    invalid(`model "${model}" is not allowed by ${ENV.allowedModels}`, `allowed models: ${config.allowedModels.join(", ")}`);
  }
  return Object.freeze({ model, effort: isFableModel(model) ? "max" : undefined, budgetUsd: config.maxBudgetUsd });
}

function validateTools(allowedTools: readonly string[]): void {
  if (allowedTools.length === 0) {
    invalid("allowedTools must not be empty", "resolve the tool list from the capability tier");
  }
  for (const tool of allowedTools) {
    if (!PATTERNS.toolToken.test(tool)) {
      invalid(`invalid tool token "${tool}"`, "tool names must be identifier-like");
    }
    if ((FORBIDDEN_TOOLS as readonly string[]).includes(tool)) {
      invalid(`write-capable tool "${tool}" is never allowed`, "Claude is an advisor only; remove Write/Edit/NotebookEdit/Bash");
    }
  }
}

export function buildClaudeArgs(spec: RunSpec): readonly string[] {
  validateTools(spec.allowedTools);
  const args: string[] = ["-p", "--output-format", "json", "--permission-mode", "default", "--allowedTools", spec.allowedTools.join(","), "--strict-mcp-config"];
  if (spec.model !== undefined) {
    if (!PATTERNS.model.test(spec.model)) {
      invalid(`model "${spec.model}" does not match the safe model pattern`, "use an alias like opus/sonnet/haiku or a full model id");
    }
    args.push("--model", spec.model);
  }
  if (spec.effort !== undefined) {
    if (!(EFFORT_LEVELS as readonly string[]).includes(spec.effort)) {
      invalid(`effort "${spec.effort}" is not one of ${EFFORT_LEVELS.join(", ")}`, "use low, medium, high, xhigh, or max");
    }
    args.push("--effort", spec.effort);
  }
  if (spec.sessionId !== undefined) {
    if (!PATTERNS.sessionId.test(spec.sessionId)) {
      invalid(`session id "${spec.sessionId}" is not a UUID`, "pass the session_id exactly as printed in a previous result footer");
    }
    args.push("-r", spec.sessionId);
  }
  if (spec.appendSystemPrompt !== undefined) {
    args.push("--append-system-prompt", spec.appendSystemPrompt);
  }
  if (spec.budgetUsd !== undefined) {
    if (!Number.isFinite(spec.budgetUsd) || spec.budgetUsd <= 0) {
      invalid(`budget must be a positive number, got ${spec.budgetUsd}`, `set ${ENV.maxBudgetUsd} to a positive number or unset it`);
    }
    args.push("--max-budget-usd", String(spec.budgetUsd));
  }
  for (const dir of spec.addDirs) {
    if (!path.isAbsolute(dir)) {
      invalid(`add-dir path must be absolute, got "${dir}"`, "pass absolute directory paths only");
    }
    if (PATTERNS.uncOrDevice.test(dir)) {
      invalid(`add-dir path must not be a UNC or device path, got "${dir}"`, "pass a local absolute path such as C:\\project or /home/user/project");
    }
    args.push("--add-dir", dir);
  }
  return Object.freeze(args);
}
