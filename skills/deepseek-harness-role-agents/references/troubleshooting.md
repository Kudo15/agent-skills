# DeepSeek Harness role agents — troubleshooting

| Symptom | Check | Fix |
| --- | --- | --- |
| `'C:\...\Programs\DeepSeek' is not recognized as an internal or external command` | Install path contains a space and the launcher re-spawned unquoted | Use the driver, or create the junction: `New-Item -ItemType Junction -Path "$env:USERPROFILE\.local\share\dsh-link" -Target "$env:LOCALAPPDATA\Programs\DeepSeek Harness"` |
| `error: --profile <name> is required` | `--patch`/other launcher flags placed before the profile | Put the profile first: `dsh headless --patch <file> --json -` |
| `profile "tui" does not exist` | Only `desktop`, `headless`, `web` are provisioned | Use `headless`; create others with `dsh plugin --profile <name> add ...` only if the user asks |
| `profile "desktop" is managed exclusively by the Electron application` | Someone tried `dsh --profile desktop` | Launch the desktop app instead |
| Read-only run says `escalation ... requires approval, but no approval channel is available` | A write or privileged command was attempted | Expected; reviewers/verifiers are read-only. Use `--role worker` (workspace-write) for edits |
| `gui_indexed: false` | Was the desktop app running? Did the 10s wait expire? | The session is still persisted; open DeepSeek Harness and reopen the workspace. Do not claim live indexing |
| `dsh` is not recognized (PowerShell/cmd) | `PATH`; the CLI lives inside the desktop bundle | Expected: never run bare `dsh`. Use `node scripts/dsh-role-task.mjs --status` (it resolves the launcher) or the `dsh-role-task.mjs` run itself |
| `--status` shows `version: -` and exit 6 | Sandbox blocked spawning the Electron binary | Rerun with access to the install dir, `ELECTRON_RUN_AS_NODE=1` spawning, `tasklist` and `~/.dsh`; do not install anything |
| `gui_attached: false` | Does `workspace.json` have a workspace whose `path` equals the cwd? | Add the folder as a workspace in the app, or rerun with `--cwd` pointed at an existing workspace (check with `--status --cwd`) |
| Session missing from the GUI but projcache entry exists | Check `workspace.json` -> the workspace's `sessionIds` | Indexing is not listing; attach the session id and restart the app |
| Session attached but still missing | Was the attach made while the app was open? | Restart DeepSeek Harness; the registry is loaded at startup |
| `DeepSeek Harness.exe` exits instantly with code 0 after launching from an agent shell | `ELECTRON_RUN_AS_NODE` is exported in the shell | Start the app with `env -u ELECTRON_RUN_AS_NODE`, or launch it from Explorer |
| `no DeepSeek credentials found` | `~/.dsh/.credentials.yaml` or `DEEPSEEK_API_KEY` | Sign in in the desktop app once, or export `DEEPSEEK_API_KEY` |
| Headless profile missing | `~/.dsh/profiles/headless/package.json` | Open the desktop app once so it provisions profiles, or reinstall DeepSeek Harness |
| CLI not found, exit 6 | `DSH_APP_DIR`, `DSH_EXE`, `DSH_CLI_JS` | Point `DSH_APP_DIR` at the install directory, or set `DSH_EXE` and `DSH_CLI_JS` explicitly |
| Preflight hangs or times out | Electron cold start | The version check allows 120s in the driver; retry, and close a stuck `DeepSeek Harness.exe` process if needed |
| Model override rejected | `--model provider/model` format | Use the config's provider id, e.g. `deepseek-official/deepseek-flash` |
| Run timed out, exit 5 | Session may still be running in the GUI | Open the session in the app, check the running tool, or rerun with a larger `--timeout` |
| Desktop update moved the install | Junction target still correct? | The junction points at the install directory, so updates in place are fine; if uninstalled, reinstall and rerun (the driver recreates a broken junction) |

## GUI visibility checklist

1. The run completed and printed a `session` event with `sessionId`.
2. `~/.dsh/storages/session_projcache/sessions/<session-id>.json` exists (desktop host indexed it).
3. The session id is in `workspace.json` under a workspace whose `path` equals the run's cwd.
4. If the app was open during the run, restart it; the GUI reads the registry at startup.
5. The workspace folder is reachable and open in the app.

Do not claim GUI visibility from `gui_indexed` alone; require `gui_attached` and a restart or a
user confirmation.
4. For a resumed session, the same session id appears; the GUI shows the new turn.

Do not claim GUI visibility from anything other than `gui_indexed` or a user confirmation.
