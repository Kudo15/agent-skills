# DeepSeek Harness (dsh) CLI contract (verified 2026-10-30)

Verified against DeepSeek Harness desktop `0.2.1-rc.5` on Windows.

## Install layout

```
%LOCALAPPDATA%\Programs\DeepSeek Harness\
  DeepSeek Harness.exe                      # Electron binary, runs Node with ELECTRON_RUN_AS_NODE=1
  resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js
  resources\runtime\cli\bin\dsh.cmd         # launcher shim (do not use from a spaced path)
```

The launcher help describes `dsh [--profile] <name> [options] [app-args...]`. Profiles live under
`~/.dsh/profiles/<name>/`. On this machine: `desktop`, `headless`, `web`.

- `desktop` is managed exclusively by the Electron application; `dsh --profile desktop` errors.
- `headless` answers one task and exits; this is what the role skill uses.
- `web` boots a web profile; `tui` is not installed here (`profile "tui" does not exist`).

## Invoking without the shim

The shim re-spawns its own executable unquoted and fails when the install directory contains a
space. Spawn the Electron binary directly instead, through a space-free junction:

```
ELECTRON_RUN_AS_NODE=1
"C:\Users\<you>\.local\share\dsh-link\DeepSeek Harness.exe" \
  --expose-internals \
  "C:\Users\<you>\.local\share\dsh-link\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" \
  headless --patch <abs\role.yml> --json -
```

`--version` prints `0.2.1-rc.5` and works through the same invocation.

## headless app flags

| Flag | Meaning |
| --- | --- |
| `<task...>` | Task text; multiple words are joined |
| `-` | Read the task from stdin (used by the driver) |
| `--json` | Newline-delimited run events on stdout instead of the final message |
| `--session-id <id>` | Adopt an existing persisted session; an unknown id is an error |

Launcher flags must come **after** the profile name: `dsh headless --patch <file> --json -`.
Putting `--patch` before the profile produced `error: --profile <name> is required`.

## JSON events (verified)

```json
{"type":"session","sessionId":"session-<uuid>","cwd":"C:\\path\\to\\project"}
{"type":"status","phase":"turn_start","turn":1}
{"type":"status","phase":"step_start","turn":1,"step":1}
{"type":"thinking","text":"..."}
{"type":"text","text":"OK"}
{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":134,"outputTokens":2,"cacheReadTokens":6144,"cacheWriteTokens":0,"totalTokens":6280}}
{"type":"status","phase":"turn_end","turn":2,"reason":{"kind":"completed"}}
{"type":"final","text":"OK"}
```

The driver takes the session id from `session`, the answer from `final` (falling back to joined
`text` events), the last `usage` object, and `turn_end.reason.kind` as `turn_end`.

## Role injection via --patch

`--patch <file>` applies an extra overlay after the profile layer. It is a YAML array of
id-targeted entries:

```yaml
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
  config:
    personaPrefix: |-
      You are the WORKER role agent ...

- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: deepseek-official
    model: deepseek-flash
```

Verified: `dsh --profile headless --dump-config` shows the overridden `personaPrefix`, and a run
with a test persona answered with the persona's mandated token. Use a YAML block scalar (`|-`) so
multi-line prompts need no escaping.

The default headless persona is `You are a coding agent powered by the {{model}} model.`
(`dsh --profile headless --dump-config | grep -A2 system-prompt`).

## Permissions

| Env value | Sandbox | Approval |
| --- | --- | --- |
| `read-only` | read-only | ask |
| `workspace-write` (default) | workspace-write | ask |
| `danger-full-access` | danger-full-access | never |

- `DSH_PERMISSION_MODE` selects the preset; the sandbox root is `process.cwd()`.
- Headless has no approval channel. Escalating from `read-only` fails with
  `escalation ... requires approval, but no approval channel is available`; in-workspace writes
  under `workspace-write` succeed without asking.
- Read-only still allows read commands (`git log`, `git diff`), so reviewers and verifiers work.
- On Windows the shell tool is `pwsh` (`tool-pwsh`); `tool-bash`/`bash-sandbox` are disabled.

## Sessions and GUI visibility

- Session files: `~/.dsh/sessions/--<escaped cwd>--/session-<uuid>/session.v4.jsonl.zstd`
  (zstd-compressed JSON lines; the first line is `{"type":"session","version":4,"id":...}`).
- Workspace registry: `~/.dsh/storages/workspace.json`; each workspace record has `path`,
  `title`, and an ordered `sessionIds`. The GUI lists a session only when its id is in the
  `sessionIds` of the workspace whose `path` equals the session's cwd. The app attaches sessions
  it creates through `WorkspaceEntity.attachSession`, which verifies the session's cwd and then
  prepends the id. Headless runs bypass that code path; the driver writes the same field itself.
- GUI index: `~/.dsh/storages/session_projcache/sessions/<session-id>.json`, written by the running
  desktop host for every session it sees, including folders that were never registered as
  workspaces. Verified by running `dsh headless` in two different folders while the app was open:
  both sessions got a cache entry within the same second, with an auto-generated title.
- Indexing is not listing. Verified with a headless run at 11:29 in the default workspace: the
  projcache entry existed and `gui_indexed` was true, yet the session was absent from the GUI until
  its id was added to `workspace.json` and the app was restarted. After the attach, the session was
  listed under Default workspace.
- The app keeps the registry in memory and does not re-read the file while running; a manual edit
  or a driver attach made while the app is open only appears after the app is restarted. A graceful
  close does not rewrite the registry, so the attach survives the restart.
- `--session-id <id> --json -` appends a new turn to the same session; an attached session shows
  the new turn after the GUI refreshes.

## Exit codes observed

| Situation | Exit |
| --- | --- |
| Successful headless run | `0` |
| Launcher usage error (`--profile is required`, unknown profile) | `1` |
| Run failure | nonzero; check `error_events` and stderr |

## Ledger schema

`~/.dsh/role-runs/board.jsonl`, one JSON object per line, appended twice per run (created, final).
Final fields:

`run_id, ts, title, role, status, harness, cli, cli_version, cwd, repo, session_id, session_dir,
session_title, model_requested, permission_mode, role_patch, gui_app, gui_indexed, gui_attached,
gui_workspace, gui_attach_note, gui_hint, turn_end, usage, error_events, exit_code, signal,
duration_ms, summary, role_result, stderr_tail, run_dir, ledger, started_at, ended_at`

Run artifacts in `runs/<run_id>/`: `prompt.md`, `role-patch.yml`, `stdout.log` (NDJSON events),
`stderr.log`, `meta.json`.
