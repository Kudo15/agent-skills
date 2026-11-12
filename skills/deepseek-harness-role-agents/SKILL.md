---
name: deepseek-harness-role-agents
description: Delegate a bounded task to DeepSeek Harness (the dsh CLI) as a role agent (worker, reviewer, verifier) from another harness - create a ledger card, run it headlessly with the role injected as a system prompt, keep the session in the DeepSeek Harness session store so it stays visible in the desktop GUI, wait for the outcome, and report back. Use when the user asks to run work through DeepSeek Harness or dsh, hand a task to a DeepSeek worker or reviewer, fan out parallel DSH workers, or wants a DeepSeek-side second opinion on a diff. Do not use for edits the harness should make itself, for one-line questions, or when DeepSeek Harness is not installed and signed in.
---

# DeepSeek Harness Role Agents

Run DeepSeek Harness (`dsh`) as a delegated role agent from inside another harness. The role is
injected as the headless profile's system prompt through a `--patch` overlay, the task runs in a
persistent DSH session, and every run is recorded in a ledger so it stays inspectable.

## Why this skill exists

Qoder CLI runs never appear in the Qoder Desktop GUI. DeepSeek Harness headless runs do, because
every `dsh headless` run persists a session under `~/.dsh/sessions/` and the running desktop app
indexes it into `~/.dsh/storages/session_projcache/`. The GUI lists a session only when its id is
also in `~/.dsh/storages/workspace.json` (the workspace that owns the folder), which the app
normally does through `workspace.attachSession`. The driver performs that attach after every run
when `--cwd`/`--repo` matches a registered GUI workspace, so the session appears in the GUI's
session list and can be reopened there afterwards. A session is not attached if the folder is not
a GUI workspace, and an attach made while the app is open becomes visible only after a restart.

## Overview

| Piece | What it is |
| --- | --- |
| Role | A `--patch` overlay targeting `system-prompt.personaPrefix` (no separate install) |
| Run | `dsh headless --json --patch <role.yml> -` with the task on stdin |
| Permissions | `DSH_PERMISSION_MODE=workspace-write` (worker) or `read-only` (reviewer/verifier) |
| Sessions | `~/.dsh/sessions/<escaped cwd>/session-<uuid>/session.v4.jsonl.zstd` |
| GUI | `session_projcache` index plus a `workspace.json` attach (driver does both) |
| Ledger | `~/.dsh/role-runs/board.jsonl` plus `runs/<run_id>/` (prompt, patch, stdout, stderr, meta) |
| Resume | `dsh headless --session-id <id> --json -`, or open the session in the GUI |

Verified against DeepSeek Harness desktop `0.2.1-rc.5` (`dsh --version` prints `0.2.1-rc.5`).

## The space-free junction

The dsh launcher re-spawns its own executable without quoting, so it fails as
`'C:\...\Programs\DeepSeek' is not recognized` when the install path contains a space. The driver
therefore runs the Electron binary through a space-free directory junction,
`~/.local/share/dsh-link` (override with `DSH_LINK_DIR`), and spawns it directly with
`ELECTRON_RUN_AS_NODE=1` plus the bundled `dsh-desktop-host/lib/cli.js`. No `dsh.cmd` shim is
involved, so multi-line prompts and paths with spaces work. The junction is created on first use.

## When to use

Use it when the user asks for a DeepSeek-side worker or reviewer, wants an independent second
implementation or review pass, or wants parallel DSH workers on separable subtasks.

Do not use it for a change you can make directly, for questions answerable by reading a file, or
when `dsh` is missing, the headless profile is not provisioned, or the app is not signed in.

## Preflight

Run these before the first delegation of a session. They are free; an actual run is billable.

```bash
node <skill>/scripts/dsh-role-task.mjs --status --cwd /abs/path/to/workspace
```

`--status` resolves the launcher the same way runs do (the junction, `DSH_EXE`/`DSH_CLI_JS`,
`DSH_APP_DIR`) and prints the version, headless profile, credentials, desktop app and whether a GUI
workspace owns `--cwd`. `dsh` is usually **not on `PATH`**: never run bare `dsh ...`, and do not
treat "dsh is not recognized" as a missing install. The driver repeats these checks and exits `6`
(CLI unusable) or `7` (not signed in) before spending anything.

## Fast path

```bash
node <skill>/scripts/dsh-role-task.mjs \
  --title "Add --verbose flag to cli.mjs" \
  --role worker \
  --body-file /tmp/task.md \
  --repo /abs/path/to/repo \
  --model deepseek-official/deepseek-flash \
  --timeout 1800
```

Add `--dry-run` first to see the exact command, the generated role patch and the body. Always pass
a `--body-file` for multi-line requirements; `--body` is for one-liners.

Exit codes: `0` done, `3` review requested, `4` blocked, `5` timeout, `1` run failed,
`6` CLI unusable, `7` not signed in, `2` usage error.

## Manual path

Equivalent invocation when the script is unavailable:

```bash
cat > /tmp/role.yml <<'EOF'
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
  config:
    personaPrefix: |-
      You are the WORKER role agent ...
      Finish your reply with exactly:
      SUMMARY: <one line>
      ROLE_RESULT: done|review|blocked
EOF

DSH_PERMISSION_MODE=workspace-write \
  dsh headless --patch /tmp/role.yml --json - <<'EOF'
<requirement text>
EOF
```

Then record the run yourself: append one JSON line to `~/.dsh/role-runs/board.jsonl` with
`run_id, ts, title, role, status, cwd, session_id, permission_mode, exit_code, summary`, and keep
stdout/stderr under `~/.dsh/role-runs/runs/<run_id>/`. Without that step the run is only visible in
the GUI, not in the ledger.

## Role contracts

Every role must end its reply with the two machine-readable lines; the driver greps them to decide
the exit code. Keep them verbatim. Prompt text lives in `ROLE_PROMPTS` inside
`scripts/dsh-role-task.mjs`; reuse it rather than paraphrasing so results stay comparable.

- **worker** — reads before editing, implements completely, runs the project's own fast checks,
  stays in scope, commits only when asked. `workspace-write`.
- **reviewer** — reads `git status` / `git diff` and the requirement, judges correctness, edge
  cases, scope creep and security, cites `file:line`, changes nothing. `read-only`.
- **verifier** — re-runs build/typecheck/tests, quotes the exact failing output, fixes nothing.
  `read-only`.

`--permission-mode danger-full-access` is refused. The headless profile has no approval channel, so
an escalation attempt fails with "requires approval, but no approval channel is available" — that
is the expected outcome for a read-only role, not a bug.

## Workspace rules

- `--repo` must be an absolute path inside a git repository; the driver resolves it with
  `git rev-parse --show-toplevel` and runs there. Without `--repo`, `--cwd` is used.
- The sandbox root is the working directory. Keep the whole worker -> reviewer -> verifier loop in
  one directory so they see the same changes.
- This skill does not create worktrees. For isolation, create one yourself and pass it as `--cwd`.
- `--resume <id>` adopts the persisted session and appends a new turn; it fails on an unknown id.
- `--model provider/model` adds an `agent-default-model` patch entry; omit it to use the profile
  default (`deepseek-official` / `deepseek-flash`).

## Visibility contract

DSH headless runs become visible in the DeepSeek Harness desktop GUI in two steps, and both are
required: the app must index the session (`session_projcache`), and the session id must be attached
to the workspace that owns the folder (`workspace.json`). After every delegation report:

1. `run_id` and ledger path (`~/.dsh/role-runs/board.jsonl`, run dir under `runs/<run_id>/`)
2. role, status, permission mode, and the role's own `SUMMARY` line
3. workspace directory and the session directory from the record
4. `session_id` and the exact resume command from the script output
5. GUI hint: DeepSeek Harness -> workspace `<cwd>` -> session `<title or id>`
6. token usage from `usage` (`inputTokens`, `outputTokens`, `cacheReadTokens`)
7. for a worker: `git -C <cwd> status --porcelain` and `git diff --stat`

`gui_indexed` means `~/.dsh/storages/session_projcache/sessions/<id>.json` appeared within 10s.
`gui_attached` means the id is in `workspace.json`; `gui_attach_note` says what is still needed:
restart the app when it was open during the run, or that no GUI workspace points at the folder.
If the folder is not a workspace, add it in the app (Workspaces -> +) and rerun, or attach it
manually; a session that is only indexed will not be listed. Never report "visible in the GUI"
from `gui_indexed` alone. Check before a run with
`node scripts/dsh-role-task.mjs --status --cwd <dir>`; on this machine the only registered
workspace is `C:\Users\ANHVU\Documents\deepseek-harness\default-workspace`, so a run in any other
folder (for example `Documents\Default Project`) will be indexed but never listed.

Show the board on request with `node scripts/dsh-role-task.mjs --list`.

## Review loop

1. Worker run -> note the session id and workspace from the ledger.
2. Reviewer run in the same workspace (`read-only`), with the requirement plus the worker's summary
   in the body.
3. Exit `3` (review requested) means the reviewer wants changes: start a **new** worker run with the
   reviewer's findings as the body. Do not resume the old session unless the user asks.
4. Verifier run last, when the requirement names checks that must pass.
5. Stop after two review rounds and report back instead of looping.

## Parallel fan-out

Split the goal into subtasks that touch disjoint files, then launch one script invocation per
subtask in the background, each with its own `--cwd` (separate worktree). Cap it at two or three
concurrent runs unless the user asks for more, and confirm before the first fan-out: every run is a
separate billable agent session. The roles do not merge; merge yourself.

## Reporting back

Report the ledger facts, not a narrative: status, summary, workspace, session id, permissions, what
was verified, and what is still open. When a run fails, quote the tail of `runs/<run_id>/stderr.log`,
the `error_events` from the record, and the exit code. Never present an unverified claim from a
role's output as fact — say what the role claimed and what you checked.

## Safety

- Never set `DSH_PERMISSION_MODE=danger-full-access`; the driver refuses it.
- Never try to bypass a sandbox denial. Fix the cause or report blocked.
- Always set `--timeout`; the default is 1800s.
- Ask before the first run of a session and before any fan-out — these are real billable runs.
- Keep `--repo`/`--cwd` inside the workspace the user pointed at.
- Do not read or print credentials, `~/.dsh/.credentials.yaml`, or any API key.
- Do not delete ledger entries or sessions without an explicit request.

## Resources

- `references/cli-contract.md` — verified profiles, flags, patch schema, permissions, output shapes
- `references/troubleshooting.md` — symptom -> check -> fix, including the path-with-space failure
- `scripts/dsh-role-task.mjs` — create/run/record/report driver (Node >= 18, stdlib only)
