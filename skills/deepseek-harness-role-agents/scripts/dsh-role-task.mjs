#!/usr/bin/env node
// Runs one DeepSeek Harness (dsh) role agent headlessly and records it in a ledger.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);

const USAGE = `dsh-role-task.mjs - run one DeepSeek Harness role agent and record it in a ledger

Usage:
  node dsh-role-task.mjs --title "..." (--body TEXT | --body-file PATH) [options]
  node dsh-role-task.mjs --list [--limit N]
  node dsh-role-task.mjs --status [--cwd PATH] [--json]

Task:
  --title TEXT            Short task title, used for the ledger and GUI report
  --body TEXT             Requirement text (single line)
  --body-file PATH        Requirement text from a file; use this for multi-line bodies

Role:
  --role NAME             worker (default) | reviewer | verifier
  --model P/M             Override the default model (provider/model)
  --permission-mode M     read-only | workspace-write
                          (default: workspace-write for worker, read-only otherwise)
  --extra ARG             Extra raw dsh argument, repeatable

Workspace:
  --repo PATH             Git repository the role works in (resolved to its root)
  --cwd PATH              Working directory when --repo is omitted (default: current dir)

Run control:
  --timeout SECONDS       Kill the run after N seconds (default 1800)
  --resume ID             Continue an existing session id instead of creating one
  --ledger DIR            Ledger root (default ~/.dsh/role-runs, env DSH_ROLE_LEDGER)
  --dry-run               Print the exact command, role patch and body, run nothing
  --json                  Print the full ledger record as JSON
  --list                  Print the ledger board and exit
  --status                Check launcher, profile, desktop app and GUI workspace, then exit
  --help                  Show this help

Exit codes: 0 done, 1 run failed, 2 usage, 3 review requested, 4 blocked,
            5 timeout, 6 CLI unusable, 7 not signed in
`;

const ROLE_CONTRACT = `
Finish your reply with exactly these two lines and nothing after them:
SUMMARY: <one line: what you did and what you verified>
ROLE_RESULT: <done|review|blocked>
`;

const ROLE_PROMPTS = {
  worker: `You are the WORKER role agent for one delegated task, running headlessly on behalf of another tool.
1. Read the user's task message and the files it touches before changing anything.
2. Implement it completely. Run the project's own checks (lint, typecheck, tests) when they exist and are quick.
3. Stay in scope: no unrelated refactors, no new dependencies unless the task asks for them.
4. Never bypass a permission check or a safety guard. If a step needs an approval you cannot obtain, stop and report blocked.
5. Commit only if the task asks you to; otherwise leave the changes in the working tree and say so.
${ROLE_CONTRACT}Use review when the work is finished but needs a human decision, blocked when you cannot finish.`,

  reviewer: `You are the REVIEWER role agent. You inspect work, you do not change it.
1. Read the user's task message, then the actual changes: git status, git diff, and the files involved.
2. Judge correctness, missed edge cases, scope creep, security problems, and whether the worker's claims are backed by the code.
3. Cite file:line for every finding. Do not edit files, do not run formatters, do not commit.
4. Running read-only commands (git, tests, linters) is fine.
${ROLE_CONTRACT}Use done to approve, review to request changes, blocked when you cannot review (missing diff, no access).`,

  verifier: `You are the VERIFIER role agent. You confirm claims by executing them.
1. Read the user's task message and the worker's stated summary.
2. Re-run the relevant checks yourself: build, typecheck, tests, and any command the task names.
3. Report what you ran, the exact failing output, and whether the task is actually met.
4. Do not fix failures and do not edit source files.
${ROLE_CONTRACT}Use done when every required check passes, review when results are ambiguous, blocked when you cannot run the checks.`
};

const TAKES_VALUE = new Set([
  '--title', '--body', '--body-file', '--role', '--model', '--permission-mode',
  '--extra', '--repo', '--cwd', '--timeout', '--resume', '--ledger', '--limit'
]);

const ALLOWED_MODES = new Set(['read-only', 'workspace-write']);

function fail(msg, code = 2) {
  process.stderr.write(`dsh-role-task: ${msg}\n`);
  if (code === 2) process.stderr.write('run with --help for usage\n');
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { role: 'worker', extra: [] };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inline = null;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) { inline = arg.slice(eq + 1); arg = arg.slice(0, eq); }
    const key = arg.replace(/^--/, '').replace(/-/g, '_');
    const value = () => {
      if (inline !== null) return inline;
      const next = argv[++i];
      if (next === undefined) fail(`missing value for ${arg}`);
      return next;
    };
    if (!arg.startsWith('--')) fail(`unexpected positional argument: ${arg}`);
    if (TAKES_VALUE.has(arg)) {
      const v = value();
      if (arg === '--extra') opts.extra.push(v);
      else opts[key] = v;
      continue;
    }
    const flags = {
      '--dry-run': 'dry_run', '--json': 'json', '--list': 'list', '--help': 'help',
      '--status': 'status'
    };
    if (flags[arg]) { opts[flags[arg]] = true; continue; }
    fail(`unknown argument: ${arg}`);
  }
  return opts;
}

function detectHarness() {
  const e = process.env;
  if (e.CODEX_HOME || e.CODEX_SANDBOX) return 'codex';
  if (e.CLAUDECODE || e.CLAUDE_CODE_ENTRYPOINT) return 'claude-code';
  if (e.QODER_SESSION_ID || e.QODER_HOME) return 'qoder';
  return 'harness';
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function appRelPaths() {
  if (process.platform === 'win32') {
    return {
      exe: 'DeepSeek Harness.exe',
      cli: path.join('resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai',
        'dsh-desktop-host', 'lib', 'cli.js')
    };
  }
  if (process.platform === 'darwin') {
    return {
      exe: path.join('MacOS', 'DeepSeek Harness'),
      cli: path.join('Resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai',
        'dsh-desktop-host', 'lib', 'cli.js')
    };
  }
  return null;
}

function defaultAppDir() {
  if (process.env.DSH_APP_DIR) return path.resolve(process.env.DSH_APP_DIR);
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'Programs', 'DeepSeek Harness');
  }
  if (process.platform === 'darwin') return '/Applications/DeepSeek Harness.app/Contents';
  return null;
}

// The upstream launcher spawns its own executable without quoting and fails when the install
// directory contains a space ("...\Programs\DeepSeek"). A space-free junction avoids the bug.
function ensureSpaceFreeRoot(appDir) {
  if (process.platform !== 'win32') return appDir;
  if (!/\s/.test(appDir)) return appDir;
  const rel = appRelPaths();
  const link = process.env.DSH_LINK_DIR
    ? path.resolve(process.env.DSH_LINK_DIR)
    : path.join(os.homedir(), '.local', 'share', 'dsh-link');
  const exeAt = (root) => path.join(root, rel.exe);
  if (isFile(exeAt(link))) return link;
  if (fs.existsSync(link)) {
    const st = fs.lstatSync(link);
    if (!st.isSymbolicLink()) {
      fail(`${link} exists and is a real directory; refusing to replace it. ` +
        'Set DSH_LINK_DIR to a free path.', 6);
    }
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `$p='${link.replace(/'/g, "''")}'; if (Test-Path $p) { (Get-Item $p).Delete() }`],
      { windowsHide: true, encoding: 'utf8' });
  }
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const ps = `New-Item -ItemType Junction -Path '${link.replace(/'/g, "''")}' ` +
    `-Target '${path.resolve(appDir).replace(/'/g, "''")}' | Out-Null`;
  const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { windowsHide: true, encoding: 'utf8', timeout: 120000 });
  if (!isFile(exeAt(link))) {
    fail('could not create the space-free junction needed to run dsh from this path. ' +
      `Run manually in PowerShell:\n  New-Item -ItemType Junction -Path '${link}' ` +
      `-Target '${path.resolve(appDir)}'\n` +
      (res.stderr ? res.stderr.trim() : ''), 6);
  }
  process.stderr.write(`dsh-role-task: using space-free junction ${link} -> ${path.resolve(appDir)}\n`);
  return link;
}

function resolveDsh() {
  const rel = appRelPaths();
  if (process.env.DSH_EXE) {
    const exe = path.resolve(process.env.DSH_EXE);
    if (!isFile(exe)) fail(`DSH_EXE not found: ${exe}`, 6);
    const cli = process.env.DSH_CLI_JS
      ? path.resolve(process.env.DSH_CLI_JS)
      : path.join(path.dirname(exe), rel ? rel.cli : '');
    return { exe, cli, label: exe };
  }
  if (!rel) fail('unsupported platform for DeepSeek Harness auto-detection; set DSH_EXE and DSH_CLI_JS', 6);
  const appDir = defaultAppDir();
  if (!appDir || !fs.existsSync(appDir)) {
    fail('could not find the DeepSeek Harness install. Install the desktop app, ' +
      'or set DSH_APP_DIR (install dir) or DSH_EXE + DSH_CLI_JS.', 6);
  }
  const root = ensureSpaceFreeRoot(appDir);
  const exe = path.join(root, rel.exe);
  const cli = path.join(root, rel.cli);
  if (!isFile(exe)) fail(`DeepSeek Harness executable not found: ${exe}`, 6);
  return { exe, cli, label: exe };
}

const DSH = resolveDsh();

function run(args, opts = {}) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  if (opts.permissionMode) env.DSH_PERMISSION_MODE = opts.permissionMode;
  const res = spawnSync(DSH.exe, ['--expose-internals', DSH.cli, ...args], {
    encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, windowsHide: true,
    cwd: opts.cwd, timeout: opts.timeout, input: opts.input, env
  });
  if (res.error && !opts.allowError) {
    fail(`could not run dsh (${args[0] ?? ''}): ${res.error.message}`, 6);
  }
  return {
    code: res.status ?? 1,
    out: res.stdout || '',
    err: res.stderr || '',
    signal: res.signal,
    error: res.error
  };
}

function git(args, cwd) {
  const res = spawnSync('git', args, { encoding: 'utf8', cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return { code: res.status ?? 1, out: (res.stdout || '').trim(), err: (res.stderr || '').trim() };
}

function ledgerRoot(opts) {
  const given = opts.ledger || process.env.DSH_ROLE_LEDGER;
  const dir = given
    ? path.resolve(String(given))
    : path.join(os.homedir(), '.dsh', 'role-runs');
  if (given && !path.isAbsolute(String(given))) {
    process.stderr.write(`dsh-role-task: note: relative ledger resolved to ${dir}\n`);
    process.stderr.write('dsh-role-task: a ledger inside a disposable task workspace is lost when that workspace is cleaned up\n');
  }
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
  return dir;
}

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
}

function appendBoard(root, record) {
  fs.appendFileSync(path.join(root, 'board.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
}

function parseRoleResult(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim());
  let result = null; let summary = null;
  for (const line of lines) {
    const r = line.match(/^ROLE_RESULT:\s*(done|review|blocked)\s*$/i);
    if (r) result = r[1].toLowerCase();
    const s = line.match(/^SUMMARY:\s*(.+)$/i);
    if (s) summary = s[1].trim();
  }
  return { result, summary };
}

function parseEvents(text) {
  let sessionId = null;
  let finalText = null;
  let usage = null;
  let turnEnd = null;
  const texts = [];
  const errors = [];
  for (const line of String(text).split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(raw); } catch { continue; }
    if (ev.type === 'session' && ev.sessionId) sessionId = ev.sessionId;
    if (ev.type === 'final' && typeof ev.text === 'string') finalText = ev.text;
    if (ev.type === 'text' && typeof ev.text === 'string') texts.push(ev.text);
    if (ev.type === 'status' && ev.usage) usage = ev.usage;
    if (ev.type === 'status' && ev.phase === 'turn_end' && ev.reason) turnEnd = ev.reason.kind || null;
    if (ev.type === 'error') {
      errors.push(ev.message || ev.error?.message || JSON.stringify(ev).slice(0, 300));
    }
  }
  return {
    sessionId,
    transcript: (finalText || texts.join('\n\n')).trim(),
    usage,
    turnEnd,
    errors
  };
}

function yamlBlock(text, indent = 6) {
  const pad = ' '.repeat(indent);
  return String(text).replace(/\r\n/g, '\n').split('\n').map((line) => `${pad}${line}`).join('\n');
}

function writeRolePatch(runDir, role, model) {
  const lines = [
    '- id: system-prompt',
    "  name: '@deepseek-ai/dsh-system-prompt'",
    '  config:',
    '    personaPrefix: |-',
    yamlBlock(ROLE_PROMPTS[role])
  ];
  if (model) {
    lines.push(
      '- id: agent-default-model',
      "  name: '@deepseek-ai/dsh-agent-default-model'",
      '  config:',
      `    provider: ${JSON.stringify(model.provider)}`,
      `    model: ${JSON.stringify(model.model)}`
    );
  }
  const file = path.join(runDir, 'role-patch.yml');
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

function sleepSync(ms) {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

function sessionsRoot() {
  return path.join(os.homedir(), '.dsh', 'sessions');
}

function findSessionDir(sessionId) {
  const root = sessionsRoot();
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const d of dirs) {
    const candidate = path.join(root, d, sessionId);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function guiCachePath(sessionId) {
  return path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
}

function waitForGuiIndex(sessionId, maxMs = 10000) {
  const file = guiCachePath(sessionId);
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return file;
    sleepSync(500);
  }
  return null;
}

function sessionTitleFromCache(file) {
  if (!file) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    return payload?.record?.rows?.title?.val || null;
  } catch { return null; }
}

function workspaceRegistryPath() {
  return path.join(os.homedir(), '.dsh', 'storages', 'workspace.json');
}

function guiAppRunning() {
  if (process.platform !== 'win32') return null;
  const res = spawnSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (res.error || res.status === null) return null;
  return res.status === 0 && /DeepSeek Harness\.exe/i.test(res.stdout || '');
}

function guiWorkspaceFor(cwd) {
  const file = workspaceRegistryPath();
  if (!cwd || !fs.existsSync(file)) return null;
  let payload;
  try { payload = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const norm = (p) => path.resolve(String(p)).toLowerCase();
  return Object.values(payload?.tables?.workspaces || {})
    .find((w) => norm(w.path) === norm(cwd)) || null;
}

// One command that answers "can this machine run a GUI-visible dsh role task?" without relying on
// `dsh` being on PATH: it resolves the same launcher the runs use.
function printStatus(opts) {
  const cwd = opts.cwd ? path.resolve(String(opts.cwd)) : null;
  const profile = path.join(os.homedir(), '.dsh', 'profiles', 'headless', 'package.json');
  const info = {
    exe: DSH.exe,
    cli: DSH.cli,
    version: null,
    headless_profile: fs.existsSync(profile),
    headless_profile_path: profile,
    credentials: fs.existsSync(path.join(os.homedir(), '.dsh', '.credentials.yaml')) ||
      Boolean(process.env.DEEPSEEK_API_KEY),
    desktop_running: guiAppRunning(),
    cwd,
    gui_workspace: null,
    gui_workspace_sessions: null
  };
  const v = run(['--version'], { allowError: true, timeout: 180000 });
  info.version = (v.out || v.err).trim().split(/\r?\n/)[0] || null;
  if (v.error) info.error = v.error.message;
  if (cwd) {
    const ws = guiWorkspaceFor(cwd);
    if (ws) {
      info.gui_workspace = ws.title || null;
      info.gui_workspace_sessions = Array.isArray(ws.sessionIds) ? ws.sessionIds.length : 0;
    }
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
    return info.version && info.headless_profile ? 0 : 6;
  }
  process.stdout.write(
    `exe: ${info.exe}\n` +
    `cli: ${info.cli}\n` +
    `version: ${info.version || '-'}\n` +
    `headless profile: ${info.headless_profile ? 'ready' : 'missing'}\n` +
    `credentials: ${info.credentials ? 'present' : 'missing'}\n` +
    `desktop app: ${info.desktop_running === null ? 'unknown (process listing unavailable)' : info.desktop_running ? 'running' : 'not running'}\n` +
    `workspace: ${cwd
      ? (info.gui_workspace ? `${info.gui_workspace} (${info.gui_workspace_sessions} sessions)` : `no GUI workspace points at ${cwd}`)
      : '(pass --cwd to check GUI listing)'}\n`);
  if (!info.version) {
    process.stderr.write('dsh-role-task: the launcher produced no version output' +
      `${info.error ? ` (${info.error})` : ''}. In a sandbox this check may be blocked: rerun with ` +
      'access to the install directory, ELECTRON_RUN_AS_NODE=1 spawning, tasklist and ~/.dsh.\n');
    return 6;
  }
  if (!info.headless_profile) {
    process.stderr.write('dsh-role-task: the headless profile is missing; open DeepSeek Harness ' +
      'once so it provisions ~/.dsh/profiles/headless, or reinstall.\n');
    return 6;
  }
  return 0;
}

// The GUI lists a session only when its id is in the workspace that owns the folder
// (workspace.attachSession). Headless runs create the session and the projcache entry but
// never attach it, so the session stays invisible until the registry names it.
function attachToWorkspace(sessionId, cwd) {
  const file = workspaceRegistryPath();
  if (!sessionId) return { attached: false, reason: 'no session id' };
  if (!fs.existsSync(file)) return { attached: false, reason: 'no workspace.json' };
  let payload;
  try { payload = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { attached: false, reason: 'workspace.json is unreadable' }; }
  const norm = (p) => path.resolve(String(p)).toLowerCase();
  const workspaces = Object.values(payload?.tables?.workspaces || {});
  const ws = workspaces.find((w) => norm(w.path) === norm(cwd));
  if (!ws) return { attached: false, reason: `no GUI workspace points at ${cwd}` };
  if (Array.isArray(ws.sessionIds) && ws.sessionIds.includes(sessionId)) {
    return { attached: true, workspace: ws.title, already: true };
  }
  try {
    ws.sessionIds = [sessionId, ...(ws.sessionIds || [])];
    ws.updatedAt = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    return { attached: true, workspace: ws.title, already: false };
  } catch (err) {
    return { attached: false, reason: `could not write workspace.json: ${err.message}` };
  }
}

function printBoard(opts) {
  const root = ledgerRoot(opts);
  const file = path.join(root, 'board.jsonl');
  if (!fs.existsSync(file)) { process.stdout.write(`no runs yet (ledger: ${root})\n`); return; }
  const limit = Number(opts.limit || 25);
  const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const latest = new Map();
  for (const r of rows) latest.set(r.run_id, r);
  const list = [...latest.values()].slice(-limit).reverse();
  process.stdout.write(`ledger: ${root}\n\n`);
  for (const r of list) {
    process.stdout.write(
      `${r.ts}  ${String(r.status).padEnd(8)} ${String(r.role).padEnd(9)} ${r.run_id}\n` +
      `    ${r.title}\n` +
      `    workspace: ${r.cwd}\n` +
      `    session: ${r.session_id || '-'}  gui: ${r.gui_attached ? 'attached' : 'not attached'}${r.gui_indexed ? '/indexed' : ''}  summary: ${r.summary || '-'}\n`);
  }
}

function failRun(root, record, status, error, code) {
  record.status = status;
  record.error = error;
  record.ended_at = new Date().toISOString();
  appendBoard(root, record);
  try { fs.writeFileSync(path.join(record.run_dir, 'meta.json'), JSON.stringify(record, null, 2), 'utf8'); } catch {}
  process.stderr.write(`dsh-role-task: ${error}\n`);
  process.exit(code);
}

function preflight(record) {
  const version = run(['--version'], { allowError: true, timeout: 180000 });
  record.cli_version = (version.out || version.err).trim().split(/\r?\n/)[0] || null;
  if (version.code !== 0 || !record.cli_version) {
    if (version.error) {
      process.stderr.write('dsh-role-task: the launcher could not be spawned from this environment. ' +
        'In a sandbox, rerun with access to the install directory, ELECTRON_RUN_AS_NODE=1 spawning ' +
        'and ~/.dsh; otherwise see references/troubleshooting.md.\n');
    }
    process.stderr.write(`dsh-role-task: could not run dsh (${DSH.exe})\n${(version.err || '').slice(-400)}\n`);
    return { ok: false, code: 6 };
  }
  const profile = path.join(os.homedir(), '.dsh', 'profiles', 'headless', 'package.json');
  if (!fs.existsSync(profile)) {
    process.stderr.write('dsh-role-task: the headless profile is missing. Open the DeepSeek Harness ' +
      'desktop app once (or reinstall it) so it provisions ~/.dsh/profiles/headless.\n');
    return { ok: false, code: 6 };
  }
  const credentials = path.join(os.homedir(), '.dsh', '.credentials.yaml');
  if (!fs.existsSync(credentials) && !process.env.DEEPSEEK_API_KEY) {
    process.stderr.write('dsh-role-task: no DeepSeek credentials found. Sign in in the DeepSeek ' +
      'Harness desktop app once, or export DEEPSEEK_API_KEY.\n');
    return { ok: false, code: 7 };
  }
  return { ok: true };
}

function parseModel(value) {
  const text = String(value).trim();
  const slash = text.indexOf('/');
  if (slash <= 0 || slash === text.length - 1) {
    fail(`--model must be provider/model (got ${value})`, 2);
  }
  return { provider: text.slice(0, slash), model: text.slice(slash + 1) };
}

function defaultPermission(role) {
  return role === 'worker' ? 'workspace-write' : 'read-only';
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(USAGE); return 0; }
  if (opts.list) { printBoard(opts); return 0; }
  if (opts.status) return printStatus(opts);

  if (!opts.title) fail('--title is required');
  const role = String(opts.role).toLowerCase();
  if (!ROLE_PROMPTS[role]) fail(`--role must be worker, reviewer or verifier (got ${opts.role})`);
  opts.role = role;

  let body = opts.body;
  if (opts.body_file) {
    if (!fs.existsSync(opts.body_file)) fail(`--body-file not found: ${opts.body_file}`, 1);
    body = fs.readFileSync(opts.body_file, 'utf8');
  }
  if (!body || !String(body).trim()) fail('a task body is required (--body or --body-file)');
  body = `${String(body).trim()}\n\nReport status with the SUMMARY and ROLE_RESULT lines described in your instructions.`;

  let permissionMode = opts.permission_mode ? String(opts.permission_mode) : defaultPermission(role);
  if (permissionMode === 'danger-full-access') {
    fail('danger-full-access is not allowed by this skill; use workspace-write or read-only', 2);
  }
  if (!ALLOWED_MODES.has(permissionMode)) {
    fail(`--permission-mode must be read-only or workspace-write (got ${permissionMode})`, 2);
  }

  const model = opts.model ? parseModel(opts.model) : null;

  let cwd = path.resolve(String(opts.cwd || process.cwd()));
  let repo = null;
  if (opts.repo) {
    repo = path.resolve(String(opts.repo));
    const root = git(['-C', repo, 'rev-parse', '--show-toplevel'], repo);
    if (root.code !== 0) fail(`--repo is not a git repository: ${repo}`, 2);
    repo = root.out;
    cwd = repo;
  }
  if (!fs.existsSync(cwd)) fail(`working directory not found: ${cwd}`, 2);

  const root = ledgerRoot(opts);
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runId = `${stamp}-${role}-${slug(opts.title)}-${crypto.randomBytes(2).toString('hex')}`;
  const runDir = path.join(root, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'prompt.md'), body, 'utf8');

  const patchPath = writeRolePatch(runDir, role, model);
  // Launcher flags must come immediately after the profile name; app flags follow.
  const args = ['headless', '--patch', patchPath, '--json'];
  if (opts.resume) args.push('--session-id', String(opts.resume));
  for (const extra of opts.extra) {
    const eq = extra.indexOf('=');
    if (eq > 0) args.push(extra.slice(0, eq), extra.slice(eq + 1));
    else args.push(extra);
  }
  args.push('-');

  const record = {
    run_id: runId, ts: startedAt.toISOString(), title: String(opts.title), role,
    status: 'created', harness: detectHarness(), cli: DSH.label,
    cwd, repo, session_id: opts.resume ? String(opts.resume) : null,
    model_requested: model ? `${model.provider}/${model.model}` : null,
    permission_mode: permissionMode, run_dir: runDir, ledger: root,
    role_patch: patchPath, started_at: startedAt.toISOString(),
    gui_app: 'DeepSeek Harness'
  };

  if (opts.dry_run) {
    process.stdout.write(`dry run: ${[DSH.exe, '--expose-internals', DSH.cli, ...args]
      .map((a) => (/[\s"'\\]/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n` +
      `\nenv: ELECTRON_RUN_AS_NODE=1 DSH_PERMISSION_MODE=${permissionMode}\n` +
      `\n--- role patch (${patchPath}) ---\n${fs.readFileSync(patchPath, 'utf8')}` +
      `\n--- body (stdin) ---\n${body}\n` +
      `\nledger: ${root}\nrun id: ${runId}\n`);
    return 0;
  }

  appendBoard(root, record);
  const ready = preflight(record);
  if (!ready.ok) failRun(root, record, 'failed',
    ready.code === 7 ? 'DeepSeek Harness is not signed in' : 'the dsh CLI is unusable', ready.code);

  const timeoutMs = Math.max(30, Number(opts.timeout || 1800)) * 1000;
  const res = run(args, { cwd, timeout: timeoutMs, input: body, permissionMode, allowError: true });
  const endedAt = new Date();

  fs.writeFileSync(path.join(runDir, 'stdout.log'), res.out || '', 'utf8');
  fs.writeFileSync(path.join(runDir, 'stderr.log'), res.err || '', 'utf8');

  const parsed = parseEvents(res.out);
  const { result: roleResult, summary } = parseRoleResult(parsed.transcript);
  const sessionId = parsed.sessionId || record.session_id;
  record.session_id = sessionId;

  record.session_dir = sessionId ? findSessionDir(sessionId) : null;
  const cacheFile = sessionId ? waitForGuiIndex(sessionId) : null;
  record.gui_indexed = Boolean(cacheFile);
  record.session_title = sessionTitleFromCache(cacheFile);
  const attached = attachToWorkspace(sessionId, cwd);
  record.gui_workspace = attached.workspace || null;
  record.gui_attached = attached.attached;
  if (attached.attached) {
    const app = guiAppRunning();
    record.gui_attach_note = app === true
      ? 'DeepSeek Harness is open; restart it to list this session'
      : app === false
        ? 'listed when DeepSeek Harness starts'
        : 'unknown whether DeepSeek Harness is open (process listing blocked); listed when the app starts or after a restart';
  } else {
    record.gui_attach_note = attached.reason;
  }
  record.gui_hint = sessionId
    ? `DeepSeek Harness -> workspace ${attached.workspace || cwd} -> session ${record.session_title || sessionId}`
    : null;

  record.ended_at = endedAt.toISOString();
  record.duration_ms = endedAt - startedAt;
  record.exit_code = res.code;
  record.signal = res.signal || null;
  record.summary = summary || (parsed.transcript ? parsed.transcript.split(/\r?\n/)[0].slice(0, 200) : null);
  record.role_result = roleResult || null;
  record.turn_end = parsed.turnEnd;
  record.usage = parsed.usage;
  record.error_events = parsed.errors;
  record.stderr_tail = res.err ? res.err.split(/\r?\n/).slice(-10).join('\n') : null;

  let exitCode = 0;
  if (res.error && (res.error.code === 'ETIMEDOUT' || res.signal)) {
    record.status = 'timeout';
    record.error = `run exceeded ${Math.round(timeoutMs / 1000)}s`;
    exitCode = 5;
    process.stderr.write(`dsh-role-task: ${record.error}\n`);
  } else if (res.error) {
    record.status = 'failed';
    record.error = `could not run dsh: ${res.error.message}`;
    exitCode = 1;
    process.stderr.write(`dsh-role-task: ${record.error}\n`);
  } else if (parsed.errors.length) {
    record.status = 'failed';
    record.error = `dsh reported: ${parsed.errors[0]}`;
    exitCode = 1;
    process.stderr.write(`dsh-role-task: ${record.error}\n`);
  } else if (res.code !== 0) {
    record.status = 'failed';
    record.error = `dsh exited ${res.code}`;
    exitCode = 1;
    process.stderr.write(`dsh-role-task: dsh exited ${res.code}\n${record.stderr_tail || ''}\n` +
      `  transcript: ${path.join(runDir, 'stdout.log')}\n`);
  } else {
    record.status = roleResult || 'done';
    exitCode = record.status === 'review' ? 3 : record.status === 'blocked' ? 4 : 0;
  }

  fs.writeFileSync(path.join(runDir, 'meta.json'),
    JSON.stringify({ ...record, transcript_tail: parsed.transcript.slice(-4000) }, null, 2), 'utf8');
  appendBoard(root, record);

  if (exitCode === 0 || exitCode === 3 || exitCode === 4) {
    if (opts.json) process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    else {
      const u = record.usage;
      const tok = u ? `in ${u.inputTokens ?? '-'} out ${u.outputTokens ?? '-'} cache-read ${u.cacheReadTokens ?? '-'}` : '-';
      process.stdout.write(
        `run ${runId}  role=${role}  status=${record.status}\n` +
        `title: ${record.title}\n` +
        `workspace: ${cwd}\n` +
        `session: ${sessionId || '-'}  gui: ${record.gui_attached ? `attached to ${record.gui_workspace}` : 'not attached'}${record.gui_attach_note ? ` (${record.gui_attach_note})` : ''}\n` +
        `resume: node ${JSON.stringify(SCRIPT_PATH)} --title resume --body "continue" --resume ${sessionId || '<id>'}\n` +
        `summary: ${record.summary || '(none reported)'}\n` +
        `permissions: ${permissionMode}  model: ${record.model_requested || 'profile default'}  tokens: ${tok}\n` +
        `ledger: ${path.join(root, 'board.jsonl')}  |  run dir: ${runDir}\n`);
      if (parsed.transcript) process.stdout.write(`\n--- output tail ---\n${parsed.transcript.slice(-2000)}\n`);
    }
    if (exitCode === 4) process.stderr.write(`\n--- stderr tail ---\n${record.stderr_tail || '(empty)'}\n`);
  }
  return exitCode;
}

let code = 0;
try { code = main(); } catch (err) {
  process.stderr.write(`dsh-role-task: ${err && err.message ? err.message : err}\n`);
  code = 1;
}
process.exit(code);
