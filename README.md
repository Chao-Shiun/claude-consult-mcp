# claude-consult-mcp

Let OpenAI Codex (CLI and desktop app) consult your local **Claude Code** while it analyzes problems: co-analysis, adversarial second opinions, and read-only file review — over the Model Context Protocol.

Claude is **advisory only** by design: it reads files and researches the web, but it can never modify anything. Implementation always stays with Codex.

```
Codex CLI / Desktop app  (shared ~/.codex/config.toml)
   |  spawns: cmd /c npx -y claude-consult-mcp   (Windows)
   |          npx -y claude-consult-mcp          (macOS / Linux)
   v
MCP stdio server (this package)
   |  9 tools by default; 10 with gate findings; 11 with journal + gate findings
   |  zod-validated, read-only allowlist, injection-hardened argv
   v
claude -p --output-format json   (your existing Claude Code login)
```

Verified in release tests against: Claude Code CLI `2.1.163`, Codex CLI `0.142.0` and `0.144.1`, MCP SDK `1.x`.

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

Codex 0.144 introduced per-server tool approval through `default_tools_approval_mode`: `"auto"` (the default), `"prompt"`, `"writes"`, or `"approve"`. All claude-consult tools declare the MCP `readOnlyHint` annotation, so the default mode auto-approves them with no configuration; set `default_tools_approval_mode = "prompt"` explicitly if you want to confirm every consultation.

`~/.codex/config.toml` is shared by the Codex CLI and desktop app, but the two install and update their engines independently. Restart the desktop app after changing the file so it reloads the server configuration. Verify with:

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

## The tools: nine by default, ten with gate findings, eleven with journal

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
| `claude_sessions` | Recover recent session ids without a Claude run | none (optional `workspace_dir`, `limit`) |
| `claude_gate_findings` | Read recent automatic review-gate findings back in-band without a Claude run | none (optional `workspace_dir`, `limit`) |
| `claude_consult_history` | Recover past consultation metadata from the opt-in machine journal across Codex sessions and server restarts | none (optional `workspace_dir`, `limit`) |

`claude_continue` also accepts `stance: "critical"` for follow-ups after an adversarial review or debate so Claude keeps its reviewer discipline.

Most Claude-calling tools also accept optional `workspace_dir` (absolute path; becomes Claude's working directory - reuse it when continuing a session), `model`, and `effort`; tools whose table row lists `workspace_dir` require it. Continuation-capable tools also accept `session_id`; `claude_panel` always starts fresh conversations. `claude_sessions` reads only the in-memory metadata ledger, `claude_gate_findings` reads only the configured review-gate findings log, and `claude_consult_history` reads only the opt-in journal. None of those recall tools invokes Claude.

Claude-calling tools also accept optional `effort` for per-call reasoning depth within the machine owner's configured ceiling.

Losing a session? Call `claude_sessions` to list recent conversations from this server process, newest first, then pass the recovered `session_id` and same `workspace_dir` to `claude_continue`.

Want recall across restarts? Set `CLAUDE_CONSULT_JOURNAL_DIR` to a local absolute directory path. The server then registers `claude_consult_history`, which lists journal entries newest first and can filter by exact `workspace_dir`.

Use `claude_gate_findings` when the user mentions review-gate findings or when starting work in a repository where the automatic review gate is installed. The tool reads the findings log resolved by the MCP server's environment: `CLAUDE_CONSULT_GATE_LOG`, or `<CLAUDE_CONSULT_JOURNAL_DIR>/review-gate.log`. If the Stop hook was installed with a different embedded log path than the MCP server environment resolves, the hook and the tool read different files; configure the same path in both places. Each entry includes a `session_id` and `repo`; each entry's `session_id` can be passed to `claude_continue` with that `repo` as `workspace_dir` to discuss that gate review with the Claude session that produced it.

Successful single-run results that actually ran Claude end with a machine-readable footer. `claude_panel` instead places one footer in each successful perspective section; failed perspective sections contain only the error:

```
---
[claude-consult] session_id: <uuid> | cost_usd: 0.12 | duration_ms: 3400 | turns: 2
```

Example prompt to Codex: *"Use the ask_claude tool to ask Claude what it thinks about this design, then continue the session and ask it to fact-check the API you plan to use."*

### Consultation journal

The journal is opt-in. Nothing is written unless `CLAUDE_CONSULT_JOURNAL_DIR` is set to a valid local absolute path; relative, UNC, and device paths are rejected. Journal files are JSONL, one file per month named `consult-journal-YYYY-MM.jsonl` under that directory.

Entries contain only the listed metadata, not dedicated prompt, file-content, or answer-body fields: ISO timestamp, originating tool, Claude `session_id`, workspace directory when present, model when present, a whitespace-collapsed topic excerpt capped at 120 characters, total cost, and duration. For review-gate entries, the 120-character topic excerpt comes from the first non-empty line of Claude's findings and may contain the complete answer when it fits within the cap. Write failures are logged to stderr and swallowed, so a disk problem cannot fail the consultation.

When the journal is enabled, fresh advisor conversations with an explicit `workspace_dir`, including gate reviews, receive a `<recent-consultations>` digest of up to 5 recent entries from the current month's journal for the same workspace, newest first. Resumed sessions never receive this digest. Disable continuity with `CLAUDE_CONSULT_CONTINUITY=0`. The digest contains only metadata the journal already stores and is injected as tagged background that Claude is told is context, not instructions.

Continuity activates only when all four conditions are true: the journal is configured, `CLAUDE_CONSULT_CONTINUITY` is not `0`, the run has no `session_id`, and the caller passes an explicit `workspace_dir`.

For clean-context fresh runs, pass `continuity: false`; this can only disable continuity and cannot enable it against the owner's `CLAUDE_CONSULT_CONTINUITY=0` switch.

Run `doctor` inside the project directory to report continuity status and counts for that workspace; it never prints journal content.

Set `CLAUDE_CONSULT_LOG_LEVEL=debug` to show one per-run continuity skip reason or injected entry count on stderr.

`claude_consult_history` is available only when the journal is enabled. It never spawns Claude and it returns plain text without a session footer.

### Gate your actions on Claude's verdict

`claude_second_opinion`, `claude_debate_open`, and `claude_debate_reply` request structured output, but Claude's schema compliance is model-dependent best-effort. Check the footer `format` field before parsing; `format: prose` means Claude answered directly and the body is wrapped for reading instead of JSON parsing:

```ts
const text = result.content[0].text;
const [body, footer = ""] = text.split("\n\n---\n");
const format = footer.match(/\| format: (json|prose)\b/)?.[1];

if (format === "json") {
  const verdict = JSON.parse(body) as { verdict: "agree" | "partial" | "disagree"; confidence: number };
  if (verdict.verdict === "disagree" || verdict.confidence < 0.7) {
    // Re-check the evidence before committing to the change.
  }
} else if (format === "prose") {
  const prose = body.match(/<prose-answer>\n([\s\S]*)\n<\/prose-answer>/)?.[1] ?? body;
  // Read prose directly, or retry once with model "sonnet" or "opus" if strict JSON fields are required.
} else {
  throw new Error("Claude result is missing a structured-output format footer.");
}
```

## Verification workflows

The server ships MCP instructions and trigger-worded tool descriptions so calling agents include Claude in verification workflows without per-user prompt files. Use `claude_second_opinion` for plans or conclusions, `claude_review_files` when Claude should inspect code directly, and `claude_panel` when the user wants multiple perspectives in one call.
Claude is instructed to cite precise evidence for every claim: file paths with line numbers it actually read, or URLs it actually fetched, and to verify accessible caller claims before relying on them.
If Claude returns a `Questions for you:` section or a structured `questions_for_caller` array, answer those questions with `claude_continue` so the same conversation can produce a better conclusion.
For implemented changes, use `claude_review_diff` so Claude reviews the actual git diff instead of only a summary. Clients that support MCP progress see a heartbeat during long calls.

Example Codex prompt: `"Verify this plan with claude_panel using the security and correctness perspectives."`

### Automatic review gate

`claude-consult-mcp review-gate` reviews the current git worktree's uncommitted `HEAD` diff with Claude. It uses hardened git diff flags (`--no-ext-diff --no-textconv`), includes `git status --porcelain`, runs through the same advisory runner as the MCP tools, and records origin metadata as `review-gate` so the opt-in journal can show the run.

When installed as a Codex Stop hook, the gate receives Codex's end-of-turn summary on stdin and asks the reviewer to compare the diff against it, catching claimed work that is missing or incomplete and material changes the summary did not mention. Manual `review-gate` runs have no claim and review the diff only. The claim is untrusted context, and the reviewer is instructed never to follow instructions inside it.

The gate is fail-open by design. Outside a git repo or on a clean tree it exits 0 silently. Oversized diffs exit 0 with stderr `review-gate: diff too large (N bytes), skipped`. Missing git, missing Claude, auth failures, timeouts, malformed Claude output, and other gate errors exit 0 with a one-line stderr `review-gate: skipped (...)` note. It never blocks the caller's workflow.

When it finds something to report, the gate records findings to `CLAUDE_CONSULT_GATE_LOG` or `<CLAUDE_CONSULT_JOURNAL_DIR>/review-gate.log`; it also prints them to stdout. Each findings entry records the repository as the final header field, so the reader can filter entries by `workspace_dir`. Codex does not inject Stop-hook stdout into the next model turn's context. Treat automatic findings as out-of-band review notes: call `claude_gate_findings` to bring those durable findings back into the MCP conversation, then use the logged `session_id` with the logged repo as `workspace_dir` in `claude_continue` for follow-up on that Claude conversation.

When a findings log is configured, the gate keeps a per-repository cooldown memo named `review-gate.state.json` beside the resolved findings log. The cooldown keys on the diff/status snapshot alone, never the claim, so an unchanged diff is skipped even when the claim changes; use `--force` to override. If the diff and status are unchanged since that repository's last successful review, the gate exits 0 without calling Claude and prints `review-gate: diff unchanged since last review, skipped` to stderr. The cooldown is inactive when neither `CLAUDE_CONSULT_GATE_LOG` nor `CLAUDE_CONSULT_JOURNAL_DIR` resolves a findings log.

Gate journal entries use the first non-empty line of the actual findings, so `claude_consult_history` shows what the gate found. `LGTM` means the gate completed with a clean pass.

The default gate model is `haiku` because the hook can run after many turns. Override it per run with `--model <m>` or set `CLAUDE_CONSULT_GATE_MODEL`; the flag wins over the environment variable. Use `--quiet` to suppress the exact `LGTM` case:

```bash
npx -y claude-consult-mcp review-gate --quiet
```

To install it as a Codex stop hook:

```bash
npx -y claude-consult-mcp setup --install-review-gate
npx -y claude-consult-mcp setup --install-review-gate --gate-log <absolute-path>
npx -y claude-consult-mcp setup --install-review-gate --journal-dir <absolute-path>
npx -y claude-consult-mcp setup --remove-review-gate
```

Setup edits `~/.codex/hooks.json`, creates a timestamped `hooks.json.bak-YYYYMMDDHHMMSS` backup before modifying an existing hooks file, preserves unrelated hooks, and replaces an existing `claude-consult-mcp review-gate` entry instead of duplicating it. Passing `--gate-log` or `--journal-dir` embeds the matching environment variable into the hook command; both paths must be local absolute paths. If neither flag is supplied, durable findings require Codex to already pass `CLAUDE_CONSULT_GATE_LOG` or `CLAUDE_CONSULT_JOURNAL_DIR` to hooks.

One-time trust: after `setup --install-review-gate`, Codex will not run the hook until you approve it once in an interactive Codex session. The trust prompt cannot be granted in headless `codex exec`. Review and approve the hook through Codex's hook trust flow when prompted. doctor reports `[warn] review-gate hook installed but not trusted - run codex interactively once and approve the hook, or it will not fire` when it finds the hook installed without a nearby `trusted_hash` record in `~/.codex/config.toml`; it only detects the trust record and does not verify Codex's trust hash.

### Evidence debate workflow

Use `claude_debate_open` for high-impact architecture, migration, or security decisions where a simple second opinion would collapse too much nuance into agree/disagree. Bring a position plus evidence items: file refs such as `src/cache.ts:40-60`, URLs, captured command output, or reasoning. For file refs, the server extracts neutral snippets from inside `workspace_dir` and embeds them in the user prompt so both sides argue over the same bytes; out-of-tree, UNC, device, or oversized exhibit reads become unavailable exhibits rather than expanding file access.

Typical two-round sketch:

1. Open: Codex calls `claude_debate_open` with the decision, current position, and supporting evidence. Claude returns JSON with `claim_verifications`, `counter_claims`, `concessions`, `remaining_disputes`, `verdict`, `confidence`, and `summary_markdown`.
2. Reply: Codex verifies Claude's cited evidence, then calls `claude_debate_reply` with `accept` for persuasive rulings and `rebut` plus new evidence for contested claims. Stop when `remaining_disputes` is empty or after three rounds; report the per-claim outcome to the user.

Debate tools are deliberately slow and expensive compared with `ask_claude`; use them for decisions where convergence and claim-by-claim evidence matter.

### Deep research depth

`claude_review_files` and `claude_review_diff` accept `depth: "deep"` when the machine owner has set `CLAUDE_CONSULT_CAPABILITY=deep-research`. Deep mode allows Claude to delegate read-only exploration to sub-agents for large scopes, then synthesize the result itself. It is slower and can use several times the turns of a standard review, so reserve it for broad audits, large directories, and risky changes.

Safety probe statement: before enabling this release, the `Agent` sub-agent token was verified with real haiku probes on Claude Code CLI `2.1.163` (2026-07-09). Under the previously assumed `Task` token no sub-agent tool exists at all; under `Agent` a sub-agent spawned, and every write attempt it made (Write, Bash, PowerShell) was denied by the default permission flow - `probe.txt` was never created. If your local Claude Code behavior differs, keep `CLAUDE_CONSULT_CAPABILITY` at the default `research`.

## Model and capability policy

The machine owner sets policy ceilings via environment variables; Codex chooses the model per call **within** those ceilings and can never exceed them.

| Who decides | What | How |
|---|---|---|
| Owner only | Capability tier (`readonly` / `research` / `deep-research`) | `CLAUDE_CONSULT_CAPABILITY` — not exposed as a tool argument, so Codex cannot self-escalate |
| Owner | Default model (`opus` out of the box) | `CLAUDE_CONSULT_MODEL` |
| Owner | Model ceiling | `CLAUDE_CONSULT_ALLOWED_MODELS` (a single value locks the model completely) |
| Codex (within the whitelist) | Per-call model | `model` tool argument |
| Owner | Effort ceiling | `CLAUDE_CONSULT_MAX_EFFORT` (`low`, `medium`, `high`, `xhigh`, `max`) |
| Codex (within the ceiling) | Per-call reasoning depth | `effort` tool argument |
| Owner only | Optional budget cap | `CLAUDE_CONSULT_MAX_BUDGET_USD` |

There is **no write tier**. The default child allowlist is `Read`, `Glob`, `Grep` for `readonly`; it adds `WebSearch` and `WebFetch` for `research`. By default, `Agent` is added for `deep-research` calls that request `depth: "deep"`. The owner-only `CLAUDE_CONSULT_ALLOWED_TOOLS` can replace the non-deep default with any valid non-forbidden tool tokens. `Write`, `Edit`, `NotebookEdit`, and `Bash` can never appear in the allowlist, and permission mode is always `default`. Fable models still default to `--effort max`, but that default is silently clamped to `CLAUDE_CONSULT_MAX_EFFORT` when the owner sets a ceiling. An explicit per-call `effort` above the ceiling is rejected with the allowed levels.

No budget cap is set by default because this package assumes a Claude subscription login with no marginal cost per run. Machines billed through an API key can opt into a spending guard by setting `CLAUDE_CONSULT_MAX_BUDGET_USD` or running `setup --max-budget-usd <n>`.

## Environment variables (all optional)

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_CONSULT_CLAUDE_BIN` | auto-detect on PATH | Full path to the claude binary |
| `CLAUDE_CONSULT_TIMEOUT_MS` | `600000` | Per-call timeout (5000..1200000) |
| `CLAUDE_CONSULT_MODEL` | `opus` | Default model; empty string = follow the claude CLI default |
| `CLAUDE_CONSULT_ALLOWED_MODELS` | unlimited | Comma-separated model whitelist ceiling |
| `CLAUDE_CONSULT_CAPABILITY` | `research` | `readonly`, `research`, or `deep-research` |
| `CLAUDE_CONSULT_ALLOWED_TOOLS` | per tier | Fine-grained tool list override; exact `Write`, `Edit`, `NotebookEdit`, and `Bash` tokens are rejected |
| `CLAUDE_CONSULT_MAX_BUDGET_USD` | unlimited | Owner-level spending guard passed as `--max-budget-usd` |
| `CLAUDE_CONSULT_MAX_THINKING_TOKENS` | unlimited | Injects `MAX_THINKING_TOKENS` to reduce thinking depth |
| `CLAUDE_CONSULT_MAX_EFFORT` | unlimited | Owner-level ceiling for per-call `effort`; unset means no ceiling |
| `CLAUDE_CONSULT_JOURNAL_DIR` | disabled | Local absolute directory for opt-in metadata-only JSONL journal files |
| `CLAUDE_CONSULT_CONTINUITY` | enabled when the journal is on | Set to `0` to disable recent-consultation context for fresh advisor runs |
| `CLAUDE_CONSULT_GATE_LOG` | disabled | Local absolute file path for durable automatic review-gate findings |
| `CLAUDE_CONSULT_GATE_MODEL` | `haiku` for `review-gate` | Default model for the review-gate CLI; `--model` overrides it |
| `CLAUDE_CONSULT_MAX_CONCURRENCY` | `2` | Max parallel claude processes (1..4) |
| `CLAUDE_CONSULT_LOG_LEVEL` | `info` | `silent` / `error` / `info` / `debug` (stderr only) |

`setup` can persist only `--model`, `--capability`, `--allowed-models`, and `--max-budget-usd` in the registered server environment: `npx -y claude-consult-mcp setup --model sonnet --capability readonly --allowed-models sonnet,haiku --max-budget-usd 1`. Configure the other variables directly for the MCP server in `~/.codex/config.toml`.

## Security notes

- Read-only by design: the exact Claude Code write/execute tool tokens `Write`, `Edit`, `NotebookEdit`, and `Bash` are always rejected before the child process is spawned; permission mode is never bypassed.
- The `deep-research` tier's default adds only the verified `Agent` sub-agent token. It does not add `Write`, `Edit`, `NotebookEdit`, or `Bash`; the forbidden-token sweep remains unconditional.
- The user prompt travels via stdin and never appears on the command line. System guidance, including the tagged continuity digest, is passed as the single value of `--append-system-prompt`; stored digest fields are output-encoded before insertion. Dynamic non-prompt argv values (session id, model, paths) are strictly validated.
- `--strict-mcp-config` keeps your own MCP servers out of the consult child process.
- No credentials are stored by this package. The child Claude process uses the machine's existing Claude Code login and inherits the server process environment like a normal child process.
- The child Claude process inherits the machine's Claude Code user configuration. User-level hooks and plugins, including memory plugins that inject prior context at session start, run inside advisor sessions too and can carry earlier local context into a review. This package neither reads nor controls that plugin context; users who want plugin-free advisor runs should configure those plugins to exclude the relevant workspaces.
- Diagnostics go to stderr only; stdout is reserved for the MCP protocol.
- On timeout or shutdown the whole claude process tree is terminated (taskkill on Windows, process-group signals on POSIX) so no orphan processes are left behind.
- UNC and device paths (`\\host\share`, `\\?\...`, `//server/share`) are rejected before any filesystem access, so a prompt-injected Codex cannot use `claude_review_files` to force NTLM authentication to a remote host.

### File-read scope

`claude_review_files` grants Claude read access (Read/Glob/Grep) to the paths you pass, so it can read **any file the OS user running Codex can read** — this is the feature, but it is also its blast radius. Because a prompt-injected Codex could target sensitive paths (`~/.ssh`, `~/.aws`, `.env` files, browser credential stores), treat the tool's reach as equal to that user account's read permissions. If that is a concern in your environment, run Codex (and therefore this server) under a least-privilege account, and only approve `claude_review_files` calls whose paths you recognize.

## Troubleshooting

Cancelling a tool call in your client also terminates the underlying claude process; nothing keeps running in the background.

| Symptom | Fix |
|---|---|
| `[CLAUDE_NOT_FOUND]` | Install Claude Code (`npm install -g @anthropic-ai/claude-code`) or set `CLAUDE_CONSULT_CLAUDE_BIN` |
| `[CLAUDE_NOT_AUTHENTICATED]` | Run `claude` interactively once on that machine to log in |
| `[SESSION_NOT_FOUND]` on `claude_continue` | Pass the same `workspace_dir` as the original call — sessions are keyed by working directory |
| Calls die around 60s | Raise `tool_timeout_sec` for this server in `~/.codex/config.toml` (setup prints the snippet) |
| `[CLAUDE_TIMEOUT]` | Raise `CLAUDE_CONSULT_TIMEOUT_MS` (default 600000) |
| Server never starts on Windows | The registration must launch `cmd /c npx ...`; run `doctor` to detect this, or re-run `setup` |
| npx says the command is not recognized right after a release | Windows npx has a brief bin-shim race on freshly published versioned specs; use the bare package name (npx -y claude-consult-mcp) or retry after a minute |
| Desktop app does not show the tools | Restart the Codex desktop app after changing `~/.codex/config.toml` |
| MCP tool calls fail with user cancelled MCP tool call | Codex 0.144+ requires approval for tools not marked read-only; upgrade claude-consult-mcp to >= 0.9.0 (all tools declare the read-only annotation), or set default_tools_approval_mode = "approve" under [mcp_servers.claude-consult] in ~/.codex/config.toml |
| `claude_consult_history` is not listed | Set `CLAUDE_CONSULT_JOURNAL_DIR` to a local absolute path in the MCP server environment and restart Codex |
| `claude_gate_findings` is not listed | Set `CLAUDE_CONSULT_GATE_LOG` or `CLAUDE_CONSULT_JOURNAL_DIR` to a local absolute path in the MCP server environment and restart Codex |
| Review gate findings are not visible in the next turn | Codex does not inject Stop-hook stdout into model context; install with `--gate-log <absolute-path>` or `--journal-dir <absolute-path>`, configure the same path for the MCP server, then call `claude_gate_findings` |
| Doctor says the review gate hook is not trusted | Run Codex interactively once and approve the hook; doctor detects the trust record but does not verify the hash |
| Continuity digest never appears | Run doctor inside that project directory - it reports whether the journal, kill switch, current-month entries, and workspace match line up; pass workspace_dir on the tool call and check CLAUDE_CONSULT_CONTINUITY |
| Remove review gate hook | `npx -y claude-consult-mcp setup --remove-review-gate` |
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
