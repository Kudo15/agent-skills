---
name: qoder-role-agents
description: Delegate a bounded task to the Qoder CLI as a role agent (worker, reviewer, verifier) from a harness such as Codex - create a ledger card, run it headlessly in its own git worktree, wait for the outcome, and report back. Use when the user asks to run work through Qoder, hand a task to a Qoder worker or reviewer, fan out parallel Qoder workers, or wants a Qoder-side second opinion on a diff. Do not use for edits the harness should make itself, for one-line questions, or when the Qoder CLI is not installed and signed in.
---

# Qoder Role Agents

Run the Qoder CLI (`qodercli`) as a delegated role agent from inside another harness. The role
(worker / reviewer / verifier) is injected as a system prompt, the task runs headlessly in an
isolated worktree, and every run is recorded in a ledger so it stays inspectable afterwards.

## Overview

| Piece | What it is |
| --- | --- |
| Role | A prompt contract injected with `--append-system-prompt`; not a separate install |
| Run | One `qoder -p ... -o json` headless invocation with a fixed `--session-id` |
| Isolation | `--worktree <name>` inside `--repo`, or a plain `-w <dir>` |
| Board | `~/.qoder/role-runs/board.jsonl` plus `runs/<run_id>/` (prompt, stdout, stderr, meta) |
| Resume | `qoder -r <session_id> -w <dir>` reopens the run interactively |

Qoder CLI runs do **not** appear in the Qoder Desktop GUI. The ledger is the board; do not claim
GUI visibility.

## When to use

Use it when the user asks for a Qoder-side worker or reviewer, wants an independent second
implementation or review pass, or wants parallel Qoder workers on separable subtasks.

Do not use it for a change you can make directly, for questions answerable by reading a file, or
when `qoder` is missing or not signed in.

## Preflight

Run these before the first delegation of a session. They are free; an actual run is billable.

```bash
qoder --version          # any current build is fine; headless works on 1.1.x
qoder status             # must show Username/Email; "Not logged in" means stop and ask for `qoder login`
qoder agents list        # confirms the CLI can read config
git -C <repo> rev-parse --show-toplevel   # required before --worktree
```

Never run these from a shell that exports `QODER_AGENT_SDK_ENTRYPOINT` (Qoder Desktop and other
agent hosts set it). That variable makes the CLI demand Agent SDK mode and fail as
`sdk_worker_removed`. The driver strips it and its siblings automatically; do not downgrade the CLI
to work around the symptom.

The script repeats these checks itself and exits `7` (not signed in) or `6` (headless unsupported)
before spending anything.

## Fast path

```bash
node <skill>/scripts/qoder-role-task.mjs \
  --title "Add --verbose flag to cli.mjs" \
  --role worker \
  --body-file /tmp/task.md \
  --repo /abs/path/to/repo \
  --worktree --branch verbose-flag \
  --timeout 1800
```

Add `--dry-run` first to see the exact command and body without running anything. Always pass a
`--body-file` for multi-line requirements; `--body` is for one-liners.

Exit codes: `0` done, `3` review requested, `4` blocked, `5` timeout, `1` run failed,
`6` headless unsupported by this CLI build, `7` CLI not signed in, `2` usage error.

## Manual path

Equivalent invocation when the script is unavailable:

```bash
qoder -p "<requirement text>

Finish with exactly:
SUMMARY: <one line>
ROLE_RESULT: done|review|blocked" \
  -o json \
  --append-system-prompt "<role contract from the script or references/cli-contract.md>" \
  --permission-mode accept_edits \
  --session-id "$(uuidgen)" \
  --name role:worker:<slug> \
  -w /abs/path/to/repo \
  --worktree <branch-name>
```

Then record the run yourself: append one JSON line to `~/.qoder/role-runs/board.jsonl` with
`run_id, ts, title, role, status, cwd, worktree, branch, session_id, exit_code, summary`, and keep
stdout/stderr under `~/.qoder/role-runs/runs/<run_id>/`. Without that step the run is invisible.

## Role contracts

Every role must end its reply with the two machine-readable lines; the script greps them to decide
the exit code. Keep them verbatim.

- **worker** — reads before editing, implements completely, runs the project's own fast checks,
  stays in scope, never bypasses a permission guard, commits only when asked. `accept_edits`.
- **reviewer** — reads `git status` / `git diff` and the requirement, judges correctness, edge
  cases, scope creep and security, cites `file:line`, changes nothing. `default` permission mode
  (writes are denied headlessly); pass `--read-only` to deny Edit/Write/NotebookEdit explicitly.
- **verifier** — re-runs build/typecheck/tests, quotes the exact failing output, does not fix
  anything. `default` permission mode, same `--read-only` option.

Role prompt text lives in `ROLE_PROMPTS` inside `scripts/qoder-role-task.mjs`; reuse it verbatim
rather than paraphrasing, so results stay comparable across runs.

## Workspace rules

- `--repo` must be an absolute path inside a git repository. Verify with `git rev-parse --show-toplevel`.
- `--worktree` gives the role a clean worktree and needs `--repo`; `--branch` names it. Without
  `--branch` Qoder picks the name. Qoder places worktrees at `<repo>/.qoder/worktrees/<sanitized>`
  and leaves an untracked `.qoder/` entry, so add that to `.gitignore` in real projects.
- The script diffs `git worktree list` before and after the run to capture the created worktree path
  and writes it into the ledger record. Read it from there instead of guessing.
- Omit `--ledger` unless the user asks. The default is user-level (`~/.qoder/role-runs`); a relative
  ledger resolves inside the harness's task workspace, which is disposable.
- Reviewers and verifiers should be pointed at the worker's worktree with `--cwd <worktree path>`,
  not at the main checkout.
- Never delete a worktree the ledger marks as used until the user has seen the diff.

## Visibility contract

Qoder CLI runs are invisible to the Qoder Desktop GUI, so report all of the following after every
delegation:

1. `run_id` and ledger path (`~/.qoder/role-runs/board.jsonl`, run dir under `runs/<run_id>/`)
2. role, status, and the role's own `SUMMARY` line
3. workspace: worktree path (or cwd) and branch
4. `session_id` and the exact resume command: `qoder -r <session_id> -w <dir>`
5. cost signal: `credits`, `turns`, and `permission_denials` from the record
6. for a worker: `git -C <worktree> status --porcelain` and `git diff --stat`

Show the board on request with `node scripts/qoder-role-task.mjs --list`.

## Review loop

1. Worker run → worktree path from the ledger.
2. Reviewer run with `--cwd <worktree>` and the requirement plus the worker's summary in the body.
3. Exit `3` (review requested) means the reviewer wants changes: start a **new** worker run in the
   same worktree using `--cwd <worktree>` and the reviewer's findings as the body. Do not resume the
   old session unless the user asks.
4. Verifier run last, when the requirement names checks that must pass.
5. Stop after two review rounds and report back instead of looping.

## Parallel fan-out

Split the goal into subtasks that touch disjoint files, then launch one script invocation per
subtask in the background, each with its own `--worktree --branch <name>`. Cap it at two or three
concurrent runs unless the user asks for more, and confirm before the first fan-out: every run is a
separate billable agent session. Merge the worktrees yourself afterwards; the roles do not merge.

## Reporting back

Report the ledger facts, not a narrative: status, summary, workspace, session id, what was
verified, and what is still open. When a run fails, quote the tail of
`runs/<run_id>/stderr.log` and the exit code. Never present an unverified claim from a role's
output as fact — say what the role claimed and what you checked.

## Safety

- Never pass `--dangerously-skip-permissions`, and do not raise `--permission-mode` to
  `bypass_permissions` or `dont_ask` to get past a denial. Fix the cause or report blocked.
- Always set `--timeout`; the default is 1800s.
- Ask before the first run of a session and before any fan-out — these are real billable runs.
- Keep `--repo`/`--cwd` inside the workspace the user pointed at; use `--add-dir` for anything else.
- Do not read or print credentials, `~/.qoder/mcp-router.json`, or any API key.
- Do not delete ledger entries, worktrees, or sessions without an explicit request.

## Resources

- `references/cli-contract.md` — verified flags, permission modes, output shape, ledger schema
- `references/troubleshooting.md` — symptom → check → fix, including `sdk_worker_removed`
- `scripts/qoder-role-task.mjs` — create/run/record/report driver (Node ≥ 18, stdlib only)
