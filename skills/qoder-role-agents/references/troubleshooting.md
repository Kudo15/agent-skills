# Troubleshooting

Symptom → check → fix. Exit codes are the driver's (`scripts/qoder-role-task.mjs`).

## `sdk_worker_removed` or `sdk_invalid_args` (exit 6)

**Verified cause: leaked environment, not a broken build.** 1.1.80 and 1.1.81 both run headless
fine. When an agent session (Qoder Desktop, an IDE host, a nested CLI agent) spawns the CLI, it
exports `QODER_AGENT_SDK_ENTRYPOINT=sdk-ts`, `QODER_AGENT_SDK_DAEMON=1`,
`QODER_AGENT_SDK_VERSION`, and `QODER_SDK_AUTH_PAYLOAD_FILE`. The CLI reads them and demands Agent
SDK duplex mode instead of `-p`.

- Check: `echo $QODER_AGENT_SDK_ENTRYPOINT`; the record's `env_stripped` field lists what the driver
  removed.
- Fix: run from a shell without those variables, or unset them for the command:
  `env -u QODER_AGENT_SDK_ENTRYPOINT -u QODER_AGENT_SDK_DAEMON -u QODER_AGENT_SDK_VERSION \
   -u QODER_SDK_AUTH_PAYLOAD_FILE qoder -p "say OK" -o text`
  The driver already does this; if exit 6 persists, some other entrypoint variable is set.
- Do **not** downgrade the CLI for this. 1.1.80 only changes the wording of the error, and a later
  `npm install`/update restores 1.1.81 anyway.

## `the Qoder CLI is not signed in` (exit 7)

- Check: `qoder status` prints `Account: Not logged in`.
- Fix: the user runs `qoder login` once in a real terminal (it is interactive), or exports
  `QODER_PERSONAL_ACCESS_TOKEN` for unattended use. Ask; do not attempt to sign in on their behalf
  and never handle the token yourself.
- Note: `--config-dir` / `QODER_CONFIG_DIR` changes which config root is read. A run that uses a
  custom config dir will not see the default sign-in.

## `could not find the Qoder CLI` (exit 1, before anything runs)

- Check: `command -v qoder qodercli`; on Windows the npm shims are `qoder.cmd` / `qodercli.cmd` in
  the npm prefix.
- Fix: install `@qoder-ai/qodercli`, or set `QODER_CLI_BIN` to the executable or to
  `node_modules/@qoder-ai/qodercli/bundle/qodercli.js`.
- Windows-specific: if the error mentions `EINVAL` or `spawn ... EACCES`, the driver fell back to a
  `.cmd` shim. Prefer the JS bundle path so arguments are passed without a shell.

## The run exits 0 but the ledger says `status: done` with no `summary`

The role did not emit the contract lines, so `parseRoleResult` found nothing.

- Check: `runs/<run_id>/stdout.log` — look for `SUMMARY:` and `ROLE_RESULT:` near the end.
- Fix: keep the role prompt verbatim (it ends with the two-line contract) and keep
  `--append-system-prompt`; if the harness also injects a system prompt, the contract may be
  overridden. Re-run with the requirement restated, and say in the body that the last two lines must
  be exactly `SUMMARY:` and `ROLE_RESULT:`.

## `--worktree` produced no worktree path in the record

The driver captures the new path by diffing `git worktree list --porcelain` before and after.

- Check: `git -C <repo> worktree list`; `git -C <repo> rev-parse --show-toplevel`.
- Causes: `--repo` is not a git repository; the run failed before Qoder created the worktree; or the
  worktree already existed with that name.
- Fix: pass an absolute `--repo` inside a real repository, and use a unique `--branch`. If the run
  still returns nothing, fall back to creating the worktree yourself and passing `--cwd <path>`:
  `git -C <repo> worktree add <repo>/.worktrees/<name> -b <name>`.

## Reviewer changed files anyway

- Check the record's `permission_mode`; it must be `default` for reviewer/verifier.
- Fix: never pass `accept_edits` to a reviewer. Re-run with `--read-only`, which adds
  `--disallowed-tools Edit|Write|NotebookEdit`. Headless runs cannot answer approval prompts, so
  `default` already denies writes — the flag is belt and braces.
- If a denial is blocking legitimate work, narrow the task; do not raise the permission mode.

## Board says `timeout` but the run clearly died in milliseconds

Observed once, during an `npm install -g` upgrade: the CLI's files were being replaced, the spawn
failed instantly, and the record showed `status: timeout`, `duration_ms: 10`, `exit_code: 1`, empty
stdout and stderr, and `cli_version: ""`.

Fixed in the driver — a spawn error is now `failed` with the OS error text, and only `ETIMEDOUT` or
a kill signal counts as `timeout`. If you still see this, the installed copy is stale: re-copy the
skill. When it happens for real, wait for the install to finish and check `qoder --version`.

## The ledger is inside a task workspace and disappears

Codex-style harnesses run each task in a disposable directory, so `--ledger work/qoder-ledger`
writes the board into something that gets cleaned up.

- Check: the `ledger:` line in the run output; a relative path is resolved against the caller's cwd.
- Fix: omit `--ledger` entirely (default `~/.qoder/role-runs`, user-level, survives cleanup), or pass
  an absolute path. The driver prints a warning when it has to resolve a relative one.

## `<repo>/.qoder/` shows up as untracked

Expected: Qoder puts worktrees in `<repo>/.qoder/worktrees/`. Add `.qoder/` to the repo's
`.gitignore` for real projects, and remove finished worktrees with
`git -C <repo> worktree remove <path>`.

## Timeout (exit 5)

- Check: `duration_ms` in the record, and the tail of `stdout.log` to see where it stalled.
- Fix: split the task, lower the scope, or raise `--timeout` deliberately (default 1800s). A run
  killed by timeout may leave a dirty worktree — inspect it with `git -C <worktree> status` before
  re-running, and do not delete it silently.

## `qoder exited 1` with an empty stderr (exit 1)

- Check `runs/<run_id>/stdout.log` first; with `-o json` an error object may be on stdout.
- Common causes: bad `--model` name (compare with `qoder --list-models`), an `--extra` argument this
  build does not accept, or a `--session-id` that already exists.
- Fix: run the printed command from `--dry-run` by hand to see the raw error.

## Two runs raced on the same worktree

There is no dispatcher and no lock. The harness schedules runs, so parallel invocations must use
different `--branch` values (or different `--cwd`). Check the board with
`node scripts/qoder-role-task.mjs --list` before launching another run.

## The user asks "where do I see this in Qoder?"

You cannot show it in the Qoder Desktop GUI — CLI runs are not rendered there. Show the ledger
instead: `--list` output, `runs/<run_id>/meta.json`, and the resume command
`qoder -r <session_id> -w <dir>`, which reopens the conversation interactively.

## Should I downgrade the CLI?

No. Version changes are not the cause of headless failures — the environment is. `qoder rollback`
and npm pins exist, but a downgrade gets overwritten by the next update and hides the real signal
(`env_stripped` plus the exact CLI error). Investigate the error text first.
