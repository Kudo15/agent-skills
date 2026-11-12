# OpenCode CLI contract (verified 2026-10-30)

Verified against OpenCode Desktop's bundled CLI, `opencode v2.2.2`, on Windows.

## Locating the CLI

1. `OPENCODE_CLI_BIN` (must be the executable, not a `.cmd`/`.bat`).
2. `opencode` / `opencode.exe` on `PATH`.
3. Windows desktop bundle:
   `%LOCALAPPDATA%\Programs\ai.opencode.desktop\resources\opencode-cli.exe`.
4. macOS desktop bundle: `/Applications/OpenCode.app/Contents/Resources/opencode-cli`.

The desktop bundle executable is a standalone binary; `ELECTRON_RUN_AS_NODE` is not needed.

## Service model (this is what makes GUI visibility work)

OpenCode 2.x runs a background service. `service status` on the resolved CLI prints its URL, for
example `http://127.0.0.1:28894`. The desktop app is a client of that same service and the CLI
defaults to it, so sessions created by `opencode run` show up in the GUI live.

`opencode` is frequently **not on `PATH`** (the desktop bundle only ships `opencode-cli.exe`).
Prefer `node scripts/opencode-role-task.mjs --status`, which resolves the CLI and reports the URL,
state pid, desktop app and `/api/info` health in one shot.

| Command | Notes |
| --- | --- |
| `<cli> service status` | Prints the URL; exit 0 when running |
| `<cli> service start` | Starts the background service |
| `<cli> service restart` | Interrupts GUI clients; only on request |
| `<cli> --standalone` | Private server, **invisible to the GUI** |

Credentials for the service live in `~/.local/state/opencode/service.json` (pid, url, password) and
`~/.config/opencode/service.json` (password). Never print either file. The API accepts
`Authorization: Basic base64("opencode:<password>")`.

## `opencode run`

```
opencode run [flags] [--] <message...>
```

| Flag | Meaning |
| --- | --- |
| `--session <id>` | Continue that session, or create it if the id does not exist |
| `--fork` | Fork the session before continuing |
| `--agent <name>` | Use a named agent from config |
| `--model <provider/model>` | Model to use, optional `#variant` suffix |
| `--format json` | Newline-delimited JSON events instead of plain text |
| `--title <text>` | Session title shown in the GUI |
| `--auto` | Auto-approve permissions that are not explicitly denied |
| `--file <path>` | Attach a file to the message |
| `--thinking` | Include thinking blocks |

`--` is **not** a reliable separator in this build: `opencode run ... -- "text"` sends `text`
twice (verified: the user message became `"text text"`). Pass the message as a single positional
argument after the flags instead.

### JSON event shape

One JSON object per line. Verified events:

```json
{"type":"step_start","sessionID":"ses_...","part":{"type":"step-start",...}}
{"type":"text","sessionID":"ses_...","part":{"type":"text","text":"...",...}}
{"type":"error","sessionID":"ses_...","error":{"type":"provider.no-route","message":"Model unavailable: ..."}}
```

The driver takes the session id from any `sessionID` field, joins `part.text` for `type:"text"`,
and treats any `type:"error"` event as a failed run. A bad model exits `1` with one error event.

## Session commands

| Command | Output |
| --- | --- |
| `opencode session list` | `<session_id>\t<title>\t<local date>` for the current project |
| `opencode session export <id>` | JSON `{info, messages}` |
| `opencode session delete <id>` | Deletes the session and its children |
| `opencode session import <file>` | Imports exported JSON |

`session export` `info` shape (verified):

```json
{
  "id": "ses_...",
  "projectID": "...",
  "agent": "role-worker",
  "model": { "id": "deepseek-flash", "providerID": "deepseek", "variant": "default" },
  "cost": 0.000893328,
  "tokens": { "input": 5816, "output": 8, "reasoning": 0, "cache": { "read": 5376, "write": 0 } },
  "outcome": "succeeded",
  "title": "worker: Add --verbose flag",
  "location": { "directory": "C:\\path\\to\\project" }
}
```

Sessions are stored by the service in `~/.local/share/opencode/opencode.db` (SQLite) and are
scoped to the project directory. A session created in another directory belongs to another project.

## Agents (role injection)

OpenCode reads markdown agents from:

- Global: `~/.config/opencode/agents/<name>.md` (verified working)
- Project: `.opencode/agents/<name>.md`

The agent name is the filename stem. Frontmatter fields used here:

```markdown
---
description: Worker role agent
mode: primary
permission:
  edit: allow
  bash: allow
---
<system prompt body>
```

`permission` values are `allow`, `ask`, `deny`. `bash` may be a single value or a map from command
pattern to value; patterns are glob-like and use the `command *` form (`"git *"`, not `"git*"`).
Verified: `edit: deny` blocks the edit tool and `bash: { "*": deny, "git *": allow }` blocks
`pwsh -Command Set-Content` even when the CLI is passed `--auto`; `--auto` only promotes `ask` to
`allow`, never a `deny`.

```markdown
permission:
  edit: deny
  bash:
    "*": deny
    "git *": allow
    "cat *": allow
```

The pattern layer is command-level, not filesystem-level: allowed commands can still write, and
redirection inside an allowed command is not inspected. Treat reviewer/verifier as best-effort
read-only; use a throwaway checkout where a hard guarantee is required.

This skill installs `role-worker.md`, `role-reviewer.md`, `role-verifier.md`. The driver copies
them into the global directory when missing, upgrades older skill-owned copies (identified by the
`<!-- opencode-role-agents:N -->` marker), and leaves edited files with the current marker alone
unless `--force-agents` is passed.

## Auth and models

- `opencode auth list` lists stored providers.
- `opencode models` lists `provider/model` ids; the requested model must appear there.
- Provider failure example: `Model unavailable: deepseek/nope-model` (exit 1).

## Ledger schema

`~/.opencode/role-runs/board.jsonl`, one JSON object per line, appended twice per run (created,
then final). Fields on the final line:

`run_id, ts, title, role, status, harness, cli, cli_version, cwd, repo, session_id,
session_title, agent, agents_dir, agents_installed, model_requested, model_used, permission_mode,
auto, service_url, gui_app, gui_visible, gui_hint, outcome, cost_usd, tokens, exit_code, signal,
duration_ms, summary, role_result, error_events, stderr_tail, run_dir, ledger, started_at,
ended_at`

Run artifacts in `runs/<run_id>/`: `prompt.md`, `stdout.log` (NDJSON events), `stderr.log`,
`meta.json`.
