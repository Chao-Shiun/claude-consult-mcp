# claude-consult-mcp

Let OpenAI Codex (CLI and desktop app) consult your local **Claude Code** while it analyzes problems: co-analysis, adversarial second opinions, and read-only file review — over the Model Context Protocol.

Claude is **advisory only** by design: it reads files and researches the web, but it can never modify anything. Implementation always stays with Codex.

```
Codex CLI / Desktop app  (shared ~/.codex/config.toml)
   |  spawns: cmd /c npx -y claude-consult-mcp   (Windows)
   |          npx -y claude-consult-mcp          (macOS / Linux)
   v
MCP stdio server (this package)
   |  8 tools, zod-validated, read-only allowlist, injection-hardened argv
   v
claude -p --output-format json   (your existing Claude Code login)
```

Verified against: Claude Code CLI `2.1.163`, Codex CLI `0.142.0`, MCP SDK `1.x`.

## Prerequisites

- Node.js >= 20
- [Claude Code](https://www.anthropic.com/claude-code) installed and logged in on each machine: `npm install -g @anthropic-ai/claude-code`, then run `claude` once
- Codex CLI >= 0.142 (`npm install -g @openai/codex`) and/or the Codex desktop app

## Quick start

```bash
npx -y claude-consult-mcp setup
```

That runs the platform-correct `codex mcp add` for you (on Windows it wraps the launcher in `cmd /c`, which Codex requires for npx-based servers). Then add the recommended timeouts to `~/.codex/config.toml` under the server section — `codex mcp add` has no flags for them:

```toml
[mcp_servers.claude-consult]
startup_timeout_sec = 60
tool_timeout_sec = 600
```

Restart the Codex desktop app so it picks up the new server. Verify with:

```bash
npx -y claude-consult-mcp doctor          # environment checks (free)
npx -y claude-consult-mcp doctor --live   # plus one real claude call (costs tokens)
codex mcp list
```

### Manual registration

```bash
# Windows
codex mcp add claude-consult -- cmd /c npx -y claude-consult-mcp

# macOS / Linux
codex mcp add claude-consult -- npx -y claude-consult-mcp
```

### 快速開始（繁體中文）

1. 每台機器先安裝並登入 Claude Code：`npm install -g @anthropic-ai/claude-code`，執行一次 `claude` 完成登入
2. 執行 `npx -y claude-consult-mcp setup` 自動註冊進 Codex（Windows 會自動加上 `cmd /c` 包裝）
3. 依上方說明把 `startup_timeout_sec = 60`、`tool_timeout_sec = 600` 加進 `~/.codex/config.toml`
4. 重啟 Codex 桌面 app；用 `npx -y claude-consult-mcp doctor` 檢查狀態

## The eight tools

| Tool | Use it for | Required args |
|---|---|---|
| `ask_claude` | General co-analysis, an independent expert view | `question` (+ optional `context`) |
| `claude_second_opinion` | Adversarial critique of Codex's own analysis before acting on it | `problem`, `analysis` |
| `claude_review_files` | Deep read-only review of real files/directories | `paths` (absolute, 1-32), `question` |
| `claude_review_diff` | Review actual git changes with diff/status context and repo read access | `workspace_dir` |
| `claude_debate_open` | Structured evidence debate for significant decisions; Claude verifies caller evidence and returns per-claim rulings | `topic`, `position`, `evidence`, `workspace_dir` |
| `claude_debate_reply` | Continue a debate round by accepting or rebutting Claude's rulings with new evidence | `session_id`, `workspace_dir`, `responses` |
| `claude_panel` | Multi-perspective verification in one call; N perspectives = N Claude runs | `task` |
| `claude_continue` | Follow-ups in the same conversation | `session_id`, `message` |

`claude_continue` also accepts `stance: "critical"` for follow-ups after an adversarial review or debate so Claude keeps its reviewer discipline.

All tools also accept optional `workspace_dir` (absolute path; becomes Claude's working directory — reuse it when continuing a session) and `model`. Continuation-capable tools also accept `session_id`; `claude_panel` always starts fresh conversations.

Every successful result ends with a machine-readable footer:

```
---
[claude-consult] session_id: <uuid> | cost_usd: 0.12 | duration_ms: 3400 | turns: 2
```

Example prompt to Codex: *"Use the ask_claude tool to ask Claude what it thinks about this design, then continue the session and ask it to fact-check the API you plan to use."*

### Gate your actions on Claude's verdict

`claude_second_opinion` returns a JSON result body before the standard footer. Parse the body and gate the next action on `verdict` and `confidence`:

```ts
const text = result.content[0].text;
const body = text.split("\n\n---\n")[0];
const verdict = JSON.parse(body) as { verdict: "agree" | "partial" | "disagree"; confidence: number };

if (verdict.verdict === "disagree" || verdict.confidence < 0.7) {
  // Re-check the evidence before committing to the change.
}
```

## Verification workflows

The server ships MCP instructions and trigger-worded tool descriptions so calling agents include Claude in verification workflows without per-user prompt files. Use `claude_second_opinion` for plans or conclusions, `claude_review_files` when Claude should inspect code directly, and `claude_panel` when the user wants multiple perspectives in one call.
Claude is instructed to cite precise evidence for every claim: file paths with line numbers it actually read, or URLs it actually fetched, and to verify accessible caller claims before relying on them.
For implemented changes, use `claude_review_diff` so Claude reviews the actual git diff instead of only a summary. Clients that support MCP progress see a heartbeat during long calls.

Example Codex prompt: `"Verify this plan with claude_panel using the security and correctness perspectives."`

### Evidence debate workflow

Use `claude_debate_open` for high-impact architecture, migration, or security decisions where a simple second opinion would collapse too much nuance into agree/disagree. Bring a position plus evidence items: file refs such as `src/cache.ts:40-60`, URLs, captured command output, or reasoning. For file refs, the server extracts neutral snippets from inside `workspace_dir` and embeds them in the user prompt so both sides argue over the same bytes; out-of-tree, UNC, device, or oversized exhibit reads become unavailable exhibits rather than expanding file access.

Typical two-round sketch:

1. Open: Codex calls `claude_debate_open` with the decision, current position, and supporting evidence. Claude returns JSON with `claim_verifications`, `counter_claims`, `concessions`, `remaining_disputes`, `verdict`, `confidence`, and `summary_markdown`.
2. Reply: Codex verifies Claude's cited evidence, then calls `claude_debate_reply` with `accept` for persuasive rulings and `rebut` plus new evidence for contested claims. Stop when `remaining_disputes` is empty or after three rounds; report the per-claim outcome to the user.

Debate tools are deliberately slow and expensive compared with `ask_claude`; use them for decisions where convergence and claim-by-claim evidence matter.

### Deep research depth

`claude_review_files` and `claude_review_diff` accept `depth: "deep"` when the machine owner has set `CLAUDE_CONSULT_CAPABILITY=deep-research`. Deep mode allows Claude to delegate read-only exploration to sub-agents for large scopes, then synthesize the result itself. It is slower and can use several times the turns of a standard review, so reserve it for broad audits, large directories, and risky changes.

Safety probe statement: before enabling this release, the `Task` sub-agent token was verified with a real haiku probe on Claude Code CLI `2.1.163`; a sub-agent write attempt could not create `probe.txt` and was blocked by the default permission flow. If your local Claude Code behavior differs, keep `CLAUDE_CONSULT_CAPABILITY` at the default `research`.

## Model and capability policy

The machine owner sets policy ceilings via environment variables; Codex chooses the model per call **within** those ceilings and can never exceed them.

| Who decides | What | How |
|---|---|---|
| Owner only | Capability tier (`readonly` / `research` / `deep-research`) | `CLAUDE_CONSULT_CAPABILITY` — not exposed as a tool argument, so Codex cannot self-escalate |
| Owner | Default model (`opus` out of the box) | `CLAUDE_CONSULT_MODEL` |
| Owner | Model ceiling | `CLAUDE_CONSULT_ALLOWED_MODELS` (a single value locks the model completely) |
| Codex (within the whitelist) | Per-call model | `model` tool argument |
| Owner only | Optional budget cap | `CLAUDE_CONSULT_MAX_BUDGET_USD` |

There is **no write tier**. The child claude process is only ever allowed `Read`, `Glob`, `Grep` (plus `WebSearch`, `WebFetch` at the default `research` tier; plus the verified `Task` sub-agent token only at `deep-research`). `Write`, `Edit`, `NotebookEdit`, and `Bash` can never appear in the allowlist, and permission mode is always `default`. Fable models automatically run at `--effort max`.

No budget cap is set by default because this package assumes a Claude subscription login with no marginal cost per run. Machines billed through an API key can opt into a spending guard by setting `CLAUDE_CONSULT_MAX_BUDGET_USD` or running `setup --max-budget-usd <n>`.

## Environment variables (all optional)

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_CONSULT_CLAUDE_BIN` | auto-detect on PATH | Full path to the claude binary |
| `CLAUDE_CONSULT_TIMEOUT_MS` | `600000` | Per-call timeout (5000..1200000) |
| `CLAUDE_CONSULT_MODEL` | `opus` | Default model; empty string = follow the claude CLI default |
| `CLAUDE_CONSULT_ALLOWED_MODELS` | unlimited | Comma-separated model whitelist ceiling |
| `CLAUDE_CONSULT_CAPABILITY` | `research` | `readonly`, `research`, or `deep-research` |
| `CLAUDE_CONSULT_ALLOWED_TOOLS` | per tier | Fine-grained tool list override (never write-capable) |
| `CLAUDE_CONSULT_MAX_BUDGET_USD` | unlimited | Owner-level spending guard passed as `--max-budget-usd` |
| `CLAUDE_CONSULT_MAX_THINKING_TOKENS` | unlimited | Injects `MAX_THINKING_TOKENS` to reduce thinking depth |
| `CLAUDE_CONSULT_MAX_CONCURRENCY` | `2` | Max parallel claude processes (1..4) |
| `CLAUDE_CONSULT_LOG_LEVEL` | `info` | `silent` / `error` / `info` / `debug` (stderr only) |

Set them at registration time so they live in the Codex config: `npx -y claude-consult-mcp setup --model sonnet --capability readonly --allowed-models sonnet,haiku --max-budget-usd 1`.

## Security notes

- Read-only by design: no write-capable tool can ever reach the child process; permission mode is never bypassed.
- The `deep-research` tier adds only the verified `Task` sub-agent token. It does not add `Write`, `Edit`, `NotebookEdit`, or `Bash`; the forbidden-token sweep remains unconditional.
- The prompt travels via stdin — never on the command line — so there is no argv escaping or injection surface; all dynamic argv values (session id, model, paths) are strictly validated.
- `--strict-mcp-config` keeps your own MCP servers out of the consult child process.
- No credentials are stored, read, or transmitted by this package; the claude CLI uses its own login on each machine.
- Diagnostics go to stderr only; stdout is reserved for the MCP protocol.
- On timeout or shutdown the whole claude process tree is terminated (taskkill on Windows, process-group signals on POSIX) so no orphan processes are left behind.
- UNC and device paths (`\\host\share`, `\\?\...`, `//server/share`) are rejected before any filesystem access, so a prompt-injected Codex cannot use `claude_review_files` to force NTLM authentication to a remote host.

### File-read scope

`claude_review_files` grants Claude read access (Read/Glob/Grep) to the paths you pass, so it can read **any file the OS user running Codex can read** — this is the feature, but it is also its blast radius. Because a prompt-injected Codex could target sensitive paths (`~/.ssh`, `~/.aws`, `.env` files, browser credential stores), treat the tool's reach as equal to that user account's read permissions. If that is a concern in your environment, run Codex (and therefore this server) under a least-privilege account, and only approve `claude_review_files` calls whose paths you recognize.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `[CLAUDE_NOT_FOUND]` | Install Claude Code (`npm install -g @anthropic-ai/claude-code`) or set `CLAUDE_CONSULT_CLAUDE_BIN` |
| `[CLAUDE_NOT_AUTHENTICATED]` | Run `claude` interactively once on that machine to log in |
| `[SESSION_NOT_FOUND]` on `claude_continue` | Pass the same `workspace_dir` as the original call — sessions are keyed by working directory |
| Calls die around 60s | Raise `tool_timeout_sec` for this server in `~/.codex/config.toml` (setup prints the snippet) |
| `[CLAUDE_TIMEOUT]` | Raise `CLAUDE_CONSULT_TIMEOUT_MS` (default 600000) |
| Server never starts on Windows | The registration must launch `cmd /c npx ...`; run `doctor` to detect this, or re-run `setup` |
| Desktop app does not show the tools | Restart the Codex desktop app after changing `~/.codex/config.toml` |
| Uninstall | `codex mcp remove claude-consult` |

## Development

```bash
npm ci
npm run typecheck
npm run build
npm test                 # unit + protocol + stdio E2E (needs a build)
npm run test:coverage    # 80% gate
CLAUDE_CONSULT_E2E=1 npx vitest run test/integration   # real claude round-trip (costs tokens)
```

## License

MIT
