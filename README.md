# agent-skills

Portable agent skills in the open `SKILL.md` format, authored in Qoder Desktop and reusable by any compatible agent: **Qoder, OpenAI Codex, Google Antigravity, Hermes Agent, Claude Code, OpenCode**.

Each skill is a self-contained folder under `skills/`:

- `SKILL.md` — YAML frontmatter (`name`, `description`) plus instructions
- optional `scripts/` (Node.js `.mjs`), `references/`, `agents/`, `ci-personas/`

## Skill catalog

### GitNexus — code-intelligence workflows

Prerequisites: GitNexus CLI installed and the target repo indexed; GitNexus MCP server configured in your agent for graph queries.

| Skill | Use |
|---|---|
| `gitnexus-guide` | What GitNexus offers: tools, graph schema, MCP resources |
| `gitnexus-cli` | Run CLI commands: analyze/index, status, wiki, list repos |
| `gitnexus-exploring` | Understand architecture, trace execution flows |
| `gitnexus-debugging` | Trace bugs and errors through the code graph |
| `gitnexus-impact-analysis` | What breaks if X changes; safety analysis before edits |
| `gitnexus-refactoring` | Safe rename / extract / split / move |
| `gitnexus-plan` | Deep, implementation-ready engineering plans |
| `gitnexus-work` | Execute a plan step by step with impact checks and commit gating |
| `gitnexus-review` | Review PRs / branches / local changes, merge-risk verdicts |
| `gitnexus-lfg` | End-to-end pipeline: plan → work → review |
| `gitnexus-pdg-query` | PDG control/data-dependence queries (CDG / REACHING_DEF) |
| `gitnexus-taint-analysis` | CFG / taint source→sink analysis |

### Role-agent dispatchers — delegate work across harnesses

Prerequisites: Node.js 18+ and the target CLI installed and authenticated. Each dispatcher supports worker / reviewer / verifier roles and parallel fan-out in isolated git worktrees.

| Skill | Target |
|---|---|
| `deepseek-harness-role-agents` | DeepSeek Harness (`dsh`) — ledger cards, headless role runs visible in the desktop app |
| `hermes-role-agents` | Hermes Agent (`hermes`) — kanban cards visible in the Hermes desktop GUI |
| `opencode-role-agents` | OpenCode (`opencode`) — shared background service, sessions visible in the OpenCode GUI |
| `qoder-role-agents` | Qoder CLI — headless runs in isolated git worktrees |

## Install

```bash
git clone https://github.com/Kudo15/agent-skills.git
cd agent-skills
bash install.sh            # link into every installed agent (junctions on Windows, symlinks elsewhere)
COPY=1 bash install.sh     # copy instead of link (no live sync)
```

Existing skill folders are never overwritten; agents that are not installed are skipped.

Manual install: copy or link each `skills/<name>` folder into the agent's skills directory:

| Agent | Global skills directory |
|---|---|
| Qoder | `~/.qoder/skills` |
| Codex | `~/.codex/skills` |
| Antigravity | `~/.gemini/config/skills` |
| Hermes | `~/.hermes/skills` (Windows: `%LOCALAPPDATA%\hermes\skills`) |
| Claude Code | `~/.claude/skills` |
| OpenCode | `~/.config/opencode/skills` |

Codex and Antigravity also support project-level skills (`.codex/skills`, `.agents/skills` in the workspace).

## Updating the backup

Skills are authored in Qoder (`~/.qoder/skills`). To sync changes into this repo:

```bash
cp -r ~/.qoder/skills/* skills/
git add -A && git commit -m "Sync skills from Qoder" && git push
```

Linked installs pick up changes immediately; copy-mode installs need the changed folders re-copied. On other machines: `git pull`.

## Portability notes

- No credentials are stored in this repo; dispatcher scripts read auth from the target CLI's own config or environment variables.
- Some skills reference machine-specific absolute paths (e.g. the Hermes kanban DB path in `hermes-role-agents/SKILL.md`). Adjust them for your machine.
- Codex skill support began as experimental (Dec 2025) — use a recent Codex release if skills are not picked up.
- GitNexus skills need the GitNexus MCP server configured per agent (e.g. `~/.codex/config.toml` for Codex, MCP settings for Antigravity).