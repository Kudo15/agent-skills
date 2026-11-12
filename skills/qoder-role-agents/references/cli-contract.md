# Qoder CLI contract (verified against 1.1.81 on Windows)

Everything marked **verified** was read from `qoder --help`, `qoder agents list`, `qoder status`, or
an actual invocation on this machine. Everything marked **unverified** comes from the docs and still
needs a live run before you rely on it.

## Binary resolution

**Verified.** `npm install -g @qoder-ai/qodercli@1.1.81` installs two shims into the npm prefix
(here `C:\QwenPaw\node`): `qoder` and `qodercli`. Package `bin` field:
`{ qoder: 'bundle/qoder-npm-dispatcher.cjs', qodercli: 'bundle/qodercli.js' }`.

The driver script resolves in this order:

1. `QODER_CLI_BIN` — a path to `qodercli`, to `bundle/qodercli.js`, or to the native exe
2. `PATH` scan for `qoder.cmd|qoder.exe|qoder|qodercli.*`; when the shim directory contains
   `node_modules/@qoder-ai/qodercli`, it runs `node <pkgdir>/bundle/qodercli.js` instead
3. `%USERPROFILE%\.qoder\bin\qodercli\qodercli.exe`

Step 2 matters on Windows: Node ≥ 18.20 refuses to spawn `.cmd`/`.bat` without `shell: true`, and a
shell would mangle the multi-line role prompt. Running the JS bundle through `process.execPath`
passes arguments verbatim. Never shell out with a prompt on the command line.

## Headless capability

**Verified on both 1.1.80 and 1.1.81.** Headless `-p` works on the current build. The failure that
looked like a broken build is an **environment** problem:

```
$ qoder -p "reply with exactly: OK" -o text
sdk_worker_removed: SDK worker sessions are no longer supported. Upgrade to the latest Qoder SDK
version, or roll back the CLI to 1.1.80 or earlier.
```

That message is misleading. It appears when the parent process exports a Qoder Agent SDK entrypoint
variable — an agent session (Qoder Desktop, an IDE host, a nested CLI agent) sets these in every
child shell, and the CLI then insists on Agent SDK duplex mode:

| Variable | Seen value |
| --- | --- |
| `QODER_AGENT_SDK_ENTRYPOINT` | `sdk-ts` |
| `QODER_AGENT_SDK_DAEMON` | `1` |
| `QODER_AGENT_SDK_VERSION` | set |
| `QODER_SDK_AUTH_PAYLOAD_FILE` | set |

On 1.1.80 the same condition reports `sdk_invalid_args`: *Agent SDK entrypoint env is set but
required flags are missing. Expected `--print --input-format stream-json --output-format
stream-json`*. That error names the real cause; 1.1.81 replaced it with the generic
`sdk_worker_removed`.

**Fix:** unset those four variables for the child process. Verified:

```
$ env -u QODER_AGENT_SDK_ENTRYPOINT -u QODER_AGENT_SDK_DAEMON \
      -u QODER_AGENT_SDK_VERSION -u QODER_SDK_AUTH_PAYLOAD_FILE \
      qoder -p "reply with exactly: OK" -o text --no-session-persistence
OK
```

The driver does this automatically for every invocation and records which variables it stripped in
`env_stripped`. Do not downgrade the CLI to work around this; the downgrade is unrelated and was
undone by a later `npm install`/update anyway.

Exit code `6` still means "the CLI demanded Agent SDK mode": check `env_stripped`, and check whether
an outer shell is exporting an entrypoint variable the driver does not know about.

## Worktree layout

**Verified.** With `-w <repo> --worktree smoke/qoder-worker`, Qoder creates the worktree at
`<repo>/.qoder/worktrees/<sanitized name>` — here `smoke/qoder-worker` became the directory
`smoke+qoder-worker` — on branch `smoke/qoder-worker`, which is the requested name unchanged. The
repository's `git status` then shows an untracked `.qoder/` entry; add it to `.gitignore` in any repo
used for real work.

The driver detects the new path by diffing `git worktree list --porcelain` before and after the run,
so the ledger always carries the real location rather than a guess. Removal stays manual:
`git -C <repo> worktree remove <path>`.

## Authentication

**Verified.** `qoder status` prints `Version: 1.1.81` and `Account: Not logged in` on a fresh
install. `qoder login` is interactive. Docs mention `QODER_PERSONAL_ACCESS_TOKEN` for CI
(**unverified** here — no token was available to test).

The driver runs `qoder status` first and exits `7` on `not logged in`, before any billable call.

## Flags that matter for role runs

All **verified** present in `qoder --help` for 1.1.81 unless noted.

| Flag | Notes |
| --- | --- |
| `-p, --print` | Non-interactive; the only way to run a role headlessly |
| `-o, --output-format` | `--help` does not enumerate the choices; docs list `text`, `json`, `stream-json` |
| `-w, --cwd <dir>` | Working directory; set it to the repo root when using `--worktree` |
| `--worktree [name]` | New git worktree; name is optional |
| `--add-dir <dir>` | Extra directory in the workspace |
| `--permission-mode <mode>` | Choices are exactly `default`, `accept_edits`, `bypass_permissions`, `dont_ask`, `auto`. There is **no** `plan` mode in this build, contrary to the docs |
| `--dangerously-skip-permissions` | Exists. Do not use it. There is no `--yolo` alias in this build |
| `--append-system-prompt <text>` | How the role contract is injected |
| `--system-prompt <text>` | Replaces the default system prompt; avoid, it drops tool guidance |
| `--session-id <id>` | Pin the id so the ledger can point at a resumable session |
| `-r, --resume [id]`, `-c, --continue`, `--fork-session` | Session continuity; `--fork-session` branches a resumed conversation |
| `-n, --name <name>` | Display name; the driver uses `role:<role>:<slug>` |
| `--no-session-persistence` | Only valid with `--print`; makes the run unresumable |
| `--list-sessions`, `--delete-session <index>` | Session inventory |
| `-m, --model`, `--reasoning-effort`, `--thinking`, `--thinking-budget`, `--context-window`, `--list-models` | Model selection |
| `--tools <tools...>`, `--allowed-tools`, `--disallowed-tools` | Tool gating; `--tools ""` disables all, `--tools default` enables all |
| `--mcp-config`, `--strict-mcp-config`, `--allowed-mcp-server-names` | MCP scoping |
| `--agent <name>`, `--agents <json>` | Run as / define subagents |
| `--settings <json|path>`, `--setting-sources <user,project,local>`, `--config-dir <dir>` | Config scoping (`--config-dir` default `~/.qoder`) |
| `--max-output-tokens`, `--max-model-request-retries` | Output and retry caps |
| `--attachment <file>` | Attach a file to the initial prompt |
| `--remote [task]`, `--remote-session`, `--remote-control` | Cloud sessions; out of scope for this skill |

**Not present in 1.1.81** despite appearing in docs: `--max-turns`, `--yolo`, `--acp`, and a `plan`
value for `--permission-mode`. Do not pass them. `--input-format <format>` exists but `--help` does
not enumerate its accepted values.

Subcommands **verified**: `mcp`, `hooks`, `rollback`, `update`, `plugins`, `commit`, `agents`,
`skills`, `feedback`, `security`, `login`, `status`, `remote-control`, `sites`, `wiki`.
`qoder agents` exposes only `list`; `qoder skills` exposes `list|enable|disable|install|link|uninstall`.

## Agents and roles

**Verified.** `qoder agents list` on this machine reports `3 active agents`, all built-in:
`Explore`, `general-purpose`, `Plan` (all `Inherit` model). No user or project agents are defined.

Two ways to express a role:

1. **System prompt injection** (what the driver does) — `--append-system-prompt "<role contract>"`.
   No files written, no config changes, identical across harnesses.
2. **Persistent subagent** — write `~/.qoder/agents/<name>.md` with frontmatter (`name`,
   `description`, `tools`, `permissionMode`, `model`, `isolation`, `maxTurns`, …) and invoke with
   `--agent <name>`. It then shows up in `qoder agents list`. **Unverified** end-to-end here.

Precedence per docs (**unverified**): built-in < user `~/.qoder/agents` < project `.qoder/agents`
< plugin < `--agents` JSON.

Read-only enforcement for reviewer/verifier comes from `--permission-mode default`: headless runs
cannot answer an approval prompt, so writes are denied. The driver's `--read-only` flag additionally
passes `--disallowed-tools Edit|Write|NotebookEdit` (tool names **unverified** for this build).

## Output shape

**Verified** from a real `-o json` run on 1.1.80 (one file created, 7 turns). Exactly one JSON
object is printed to stdout, no extra lines:

```
type            "result"
subtype         "success"
is_error        false
duration_ms     18570          API time; wall clock was ~42.8s including startup
duration_api_ms 15570
num_turns       7
result          "<the final assistant message>"
stop_reason     "end_turn"
total_cost_usd  0              always 0 on this plan
total_credits   0.8453         the number that actually accrues
usage           { input_tokens, output_tokens, cache_read_input_tokens, service_tier,
                  context_usage_ratio, request_id, ... }
modelUsage      { "auto": { ..., "credits": 0.8453, "contextWindow": 0 } }
permission_denials  []         names/args of anything the harness refused
fast_mode_state "off"
uuid            "<message uuid>"
session_id      "<matches --session-id>"
```

Consequences for the driver:

- `session_id` round-trips, so the ledger handle and `qoder -r <id>` are reliable.
- `total_cost_usd` is useless here; record `total_credits` (field `credits`).
- `is_error` can be true while the process exits 0 — treat it as a failed run.
- `permission_denials` is a good signal that a reviewer/verifier tried to write.
- Token counters read 0; do not build accounting on `usage`.
- The role's own `SUMMARY:` / `ROLE_RESULT:` lines remain the authoritative status signal; the
  driver prefers them over `stop_reason`.

Parsing stays defensive (whole-stdout parse, then a brace slice, then the last JSON-looking line),
and plain text is still accepted if `-o json` behaviour changes.

## Ledger schema

Root: `~/.qoder/role-runs` (override with `--ledger` or `QODER_ROLE_LEDGER`).

```
board.jsonl                     one JSON line per state change, append-only
runs/<run_id>/prompt.md         exact body sent
runs/<run_id>/stdout.log        raw stdout
runs/<run_id>/stderr.log        raw stderr
runs/<run_id>/meta.json         final record plus transcript_tail
```

`run_id` = `<ISO stamp>-<role>-<title slug>-<4 hex>`, e.g.
`2026-10-30T02-10-42-reviewer-preflight-probe-524e`.

Record fields: `run_id, ts, title, role, status, harness, cli, cli_version, cwd, repo, worktree,
branch, session_id, permission_mode, model, model_used, run_dir, ledger, started_at, ended_at,
duration_ms, exit_code, signal, summary, role_result, cost_usd, credits, turns,
permission_denials, subtype, stop_reason, env_stripped, error, stderr_tail`.

`status` values: `created` (written before the run), then `done`, `review`, `blocked`, `timeout`,
or `failed`. A run normally produces two board lines; `--list` collapses to the latest per
`run_id`.

`harness` is detected from the environment: `CODEX_HOME`/`CODEX_SANDBOX` → `codex`,
`CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT` → `claude-code`, `QODER_SESSION_ID`/`QODER_HOME` → `qoder`,
else `harness`.

## What is *not* true

- Qoder CLI runs do not appear in the Qoder Desktop app. Desktop chat sessions and CLI sessions are
  separate stores; there is no board the GUI renders for CLI runs.
- There is no dispatcher, no queue, and no daemon. The harness is the scheduler: one script
  invocation equals one run.
- `--worktree` cleanup is not managed for you; worktrees stay on disk until you remove them.
