#!/usr/bin/env node
// Runs one Qoder CLI role agent (worker/reviewer/verifier) headlessly and records it in a ledger.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const USAGE = `qoder-role-task.mjs - run one Qoder CLI role agent and record it in a ledger

Usage:
  node qoder-role-task.mjs --title "..." (--body TEXT | --body-file PATH) [options]
  node qoder-role-task.mjs --list [--limit N]

Task:
  --title TEXT            Short task title, also used as the session name
  --body TEXT             Requirement text (single line)
  --body-file PATH        Requirement text from a file; use this for multi-line bodies

Role:
  --role NAME             worker (default) | reviewer | verifier
  --model NAME            Passed to qoder --model
  --reasoning-effort LVL  Passed to qoder --reasoning-effort
  --permission-mode M     default | accept_edits | dont_ask | auto
                          (default: accept_edits for worker, default for reviewer/verifier)
  --max-output-tokens N   Passed through
  --read-only             Also deny Edit/Write/NotebookEdit (belt and braces for reviewer/verifier)
  --extra ARG             Extra raw qoder argument, repeatable (quote it: --extra "--add-dir=/tmp/x")

Workspace:
  --repo PATH             Git repository the role works in
  --cwd PATH              Working directory when not using a worktree (default: current dir)
  --worktree              Ask qoder for a new git worktree (requires --repo)
  --branch NAME           Worktree name passed to qoder --worktree
  --add-dir PATH          Extra directory to expose, repeatable

Run control:
  --timeout SECONDS       Kill the run after N seconds (default 1800)
  --no-persist            Pass --no-session-persistence; the ledger becomes the only record
  --resume ID             Resume an existing session instead of starting a new one
  --ledger DIR            Ledger root (default ~/.qoder/role-runs, env QODER_ROLE_LEDGER)
  --dry-run               Print the exact qoder command and body, run nothing
  --json                  Print the full ledger record as JSON
  --list                  Print the ledger board and exit
  --help                  Show this help

Exit codes: 0 done, 1 run failed, 2 usage, 3 review requested, 4 blocked,
            5 timeout, 6 headless unsupported by this CLI build, 7 not signed in
`;

const ROLE_CONTRACT = `
Finish your reply with exactly these two lines and nothing after them:
SUMMARY: <one line: what you did and what you verified>
ROLE_RESULT: <done|review|blocked>
`;

const ROLE_PROMPTS = {
  worker: `You are the WORKER role agent for one delegated task, running headlessly on behalf of another tool.
1. Read the requirement below and the files it touches before changing anything.
2. Implement it completely. Run the project's own checks (lint, typecheck, tests) when they exist and are quick.
3. Stay in scope: no unrelated refactors, no new dependencies unless the requirement asks for them.
4. Never bypass a permission check or a safety guard. If a step needs an approval you cannot obtain, stop and report blocked.
5. Commit only if the requirement asks you to; otherwise leave the changes in the working tree and say so.
${ROLE_CONTRACT}Use review when the work is finished but needs a human decision, blocked when you cannot finish.`,

  reviewer: `You are the REVIEWER role agent. You inspect work, you do not change it.
1. Read the requirement below, then the actual changes: git status, git diff, and the files involved.
2. Judge correctness, missed edge cases, scope creep, security problems, and whether the worker's claims are backed by the code.
3. Cite file:line for every finding. Do not edit files, do not run formatters, do not commit.
4. Running read-only commands (git, tests, linters) is fine.
${ROLE_CONTRACT}Use done to approve, review to request changes, blocked when you cannot review (missing diff, no access).`,

  verifier: `You are the VERIFIER role agent. You confirm claims by executing them.
1. Read the requirement below and the worker's stated summary.
2. Re-run the relevant checks yourself: build, typecheck, tests, and any command the requirement names.
3. Report what you ran, the exact failing output, and whether the requirement is actually met.
4. Do not fix failures and do not edit source files.
${ROLE_CONTRACT}Use done when every required check passes, review when results are ambiguous, blocked when you cannot run the checks.`
};

const TAKES_VALUE = new Set([
  '--title', '--body', '--body-file', '--role', '--model', '--reasoning-effort',
  '--permission-mode', '--max-output-tokens', '--extra', '--repo', '--cwd',
  '--branch', '--add-dir', '--timeout', '--resume', '--ledger', '--limit'
]);

function fail(msg, code = 2) {
  process.stderr.write(`qoder-role-task: ${msg}\n`);
  if (code === 2) process.stderr.write('run with --help for usage\n');
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { role: 'worker', extra: [], add_dir: [] };
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
      else if (arg === '--add-dir') opts.add_dir.push(v);
      else opts[key] = v;
      continue;
    }
    const flags = {
      '--worktree': 'worktree', '--dry-run': 'dry_run', '--json': 'json',
      '--list': 'list', '--help': 'help', '--no-persist': 'no_persist',
      '--read-only': 'read_only'
    };
    if (flags[arg]) { opts[flags[arg]] = true; continue; }
    fail(`unknown argument: ${arg}`);
  }
  return opts;
}

function detectHarness() {
  const e = process.env;
  if (e.ANTIGRAVITY_AGENT || e.ANTIGRAVITY_CONVERSATION_ID) return 'antigravity';
  if (e.CODEX_HOME || e.CODEX_SANDBOX) return 'codex';
  if (e.CLAUDECODE || e.CLAUDE_CODE_ENTRYPOINT) return 'claude-code';
  if (e.QODER_SESSION_ID || e.QODER_HOME) return 'qoder';
  return 'harness';
}

// Node refuses to spawn .cmd/.bat without a shell, and a shell would mangle multi-line prompts.
// Prefer the CLI's JS bundle so arguments are passed verbatim.
function findBundleJs(dir) {
  const rel = [
    path.join('node_modules', '@qoder-ai', 'qodercli'),
    path.join('..', 'lib', 'node_modules', '@qoder-ai', 'qodercli'),
    path.join('@qoder-ai', 'qodercli')
  ];
  for (const base of rel) {
    const pkgDir = path.resolve(dir, base);
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
      const bin = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin && pkg.bin.qodercli);
      if (bin) {
        const js = path.join(pkgDir, bin);
        if (fs.existsSync(js)) return js;
      }
    } catch {}
    const guess = path.join(pkgDir, 'bundle', 'qodercli.js');
    try { if (fs.existsSync(guess)) return guess; } catch {}
  }
  return null;
}

function resolveQoder() {
  const explicit = process.env.QODER_CLI_BIN;
  if (explicit) {
    if (/\.(m|c)?js$/i.test(explicit)) return { exe: process.execPath, prefix: [explicit], label: `${explicit} (node)` };
    if (/\.(cmd|bat)$/i.test(explicit)) {
      const js = findBundleJs(path.dirname(explicit));
      if (js) return { exe: process.execPath, prefix: [js], label: `${js} (node)` };
      fail(`QODER_CLI_BIN points at a shell shim (${explicit}); point it at the JS bundle instead`, 1);
    }
    return { exe: explicit, prefix: [], label: explicit };
  }
  const names = process.platform === 'win32'
    ? ['qoder.cmd', 'qoder.exe', 'qoder', 'qodercli.cmd', 'qodercli.exe', 'qodercli']
    : ['qoder', 'qodercli'];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      let found = false;
      try { found = fs.existsSync(candidate); } catch {}
      if (!found) continue;
      const js = findBundleJs(dir);
      if (js) return { exe: process.execPath, prefix: [js], label: `${js} (node)` };
      if (!/\.(cmd|bat)$/i.test(candidate)) return { exe: candidate, prefix: [], label: candidate };
    }
  }
  const native = path.join(os.homedir(), '.qoder', 'bin', 'qodercli',
    process.platform === 'win32' ? 'qodercli.exe' : 'qodercli');
  try { if (fs.existsSync(native)) return { exe: native, prefix: [], label: native }; } catch {}
  const js = findBundleJs(path.join(os.homedir(), '.qoder'));
  if (js) return { exe: process.execPath, prefix: [js], label: `${js} (node)` };
  fail('could not find the Qoder CLI. Install it with `npm install -g @qoder-ai/qodercli` ' +
    'or point QODER_CLI_BIN at qodercli / its bundle/qodercli.js', 1);
}

const QODER = resolveQoder();

// An agent session (Qoder Desktop, an IDE host) exports these into child shells. The CLI reads
// them and demands Agent SDK duplex mode instead of -p, which fails as sdk_worker_removed or
// sdk_invalid_args. Role runs must start clean.
const SDK_ENV = [
  'QODER_AGENT_SDK_ENTRYPOINT', 'QODER_AGENT_SDK_DAEMON',
  'QODER_AGENT_SDK_VERSION', 'QODER_SDK_AUTH_PAYLOAD_FILE'
];

function childEnv() {
  const env = { ...process.env };
  for (const key of SDK_ENV) delete env[key];
  return env;
}

function strippedEnv() {
  return SDK_ENV.filter((key) => process.env[key] !== undefined);
}

function run(args, opts = {}) {
  const res = spawnSync(QODER.exe, [...QODER.prefix, ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    cwd: opts.cwd, timeout: opts.timeout, env: childEnv()
  });
  if (res.error && !opts.allowError) fail(`could not run qoder (${args[0] ?? ''}): ${res.error.message}`, 1);
  return { code: res.status ?? 1, out: (res.stdout || '').trim(), err: (res.stderr || '').trim(), signal: res.signal, error: res.error };
}

function git(args, cwd) {
  const res = spawnSync('git', args, { encoding: 'utf8', cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return { code: res.status ?? 1, out: (res.stdout || '').trim(), err: (res.stderr || '').trim() };
}

function worktreePaths(repo) {
  const res = git(['-C', repo, 'worktree', 'list', '--porcelain'], repo);
  if (res.code !== 0) return [];
  return res.out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length).trim());
}

function ledgerRoot(opts) {
  const given = opts.ledger || process.env.QODER_ROLE_LEDGER;
  const dir = given
    ? path.resolve(String(given))
    : path.join(os.homedir(), '.qoder', 'role-runs');
  if (given && !path.isAbsolute(String(given))) {
    process.stderr.write(`qoder-role-task: note: relative ledger resolved to ${dir}\n`);
    process.stderr.write('qoder-role-task: a ledger inside a disposable task workspace is lost when that workspace is cleaned up\n');
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

function extractJson(text) {
  const t = String(text).trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch {}
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(t.slice(first, last + 1)); } catch {}
  }
  for (const line of t.split(/\r?\n/).reverse()) {
    const s = line.trim();
    if (s.startsWith('{') && s.endsWith('}')) { try { return JSON.parse(s); } catch {} }
  }
  return null;
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
      `    workspace: ${r.worktree || r.cwd}${r.branch ? ` (branch ${r.branch})` : ''}\n` +
      `    session: ${r.session_id || '-'}  summary: ${r.summary || '-'}\n`);
  }
}

function failRun(root, record, status, error, code) {
  record.status = status;
  record.error = error;
  record.ended_at = new Date().toISOString();
  appendBoard(root, record);
  try { fs.writeFileSync(path.join(record.run_dir, 'meta.json'), JSON.stringify(record, null, 2), 'utf8'); } catch {}
  process.stderr.write(`qoder-role-task: ${error}\n`);
  process.exit(code);
}

function preflight(root, record) {
  const version = run(['--version'], { allowError: true });
  record.cli_version = (version.out || version.err).trim() || null;
  const status = run(['status'], { allowError: true, timeout: 60000 });
  const statusText = `${status.out}\n${status.err}`;
  if (/not logged in|no account|sign in to continue/i.test(statusText)) {
    failRun(root, record, 'failed',
      'the Qoder CLI is not signed in. Fix: run `qoder login` once interactively, ' +
      'or export QODER_PERSONAL_ACCESS_TOKEN for CI.', 7);
  }
  return record.cli_version;
}

function buildArgs(opts, body, runDir, sessionId) {
  const role = opts.role;
  const isWorker = role === 'worker';
  const args = ['-p', body, '-o', 'json', '--append-system-prompt', ROLE_PROMPTS[role]];
  const mode = opts.permission_mode || (isWorker ? 'accept_edits' : 'default');
  args.push('--permission-mode', mode);
  if (opts.read_only) {
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) args.push('--disallowed-tools', tool);
  }
  if (opts.model) args.push('--model', String(opts.model));
  if (opts.reasoning_effort) args.push('--reasoning-effort', String(opts.reasoning_effort));
  if (opts.max_output_tokens) args.push('--max-output-tokens', String(opts.max_output_tokens));
  if (opts.resume) args.push('--resume', String(opts.resume));
  else if (sessionId) args.push('--session-id', sessionId);
  args.push('--name', `role:${role}:${slug(opts.title)}`);
  if (opts.no_persist) args.push('--no-session-persistence');

  const cwd = opts.repo ? path.resolve(String(opts.repo)) : path.resolve(String(opts.cwd || process.cwd()));
  args.push('-w', cwd);
  if (opts.worktree) {
    if (!opts.repo) fail('--worktree requires --repo');
    if (opts.branch) args.push('--worktree', String(opts.branch));
    else args.push('--worktree');
  }
  for (const dir of opts.add_dir) args.push('--add-dir', path.resolve(String(dir)));
  for (const extra of opts.extra) {
    const eq = extra.indexOf('=');
    if (eq > 0) args.push(extra.slice(0, eq), extra.slice(eq + 1));
    else args.push(extra);
  }
  return { args, cwd, mode };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(USAGE); return 0; }
  if (opts.list) { printBoard(opts); return 0; }

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

  const root = ledgerRoot(opts);
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runId = `${stamp}-${role}-${slug(opts.title)}-${crypto.randomBytes(2).toString('hex')}`;
  const runDir = path.join(root, 'runs', runId);
  const sessionId = opts.resume ? null : crypto.randomUUID();
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'prompt.md'), body, 'utf8');

  const { args, cwd, mode } = buildArgs(opts, body, runDir, sessionId);

  const record = {
    run_id: runId, ts: startedAt.toISOString(), title: String(opts.title), role,
    status: 'created', harness: detectHarness(), cli: QODER.label, cwd,
    repo: opts.repo ? path.resolve(String(opts.repo)) : null,
    worktree: null, branch: opts.branch || null,
    session_id: opts.resume ? String(opts.resume) : sessionId,
    permission_mode: mode, model: opts.model || null, run_dir: runDir,
    ledger: root, started_at: startedAt.toISOString()
  };

  if (opts.dry_run) {
    process.stdout.write(`dry run: ${[QODER.exe, ...QODER.prefix, ...args]
      .map((a) => (/[\s"'\\]/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n\n--- body ---\n${body}\n`);
    process.stdout.write(`\nledger: ${root}\nrun id: ${runId}\n`);
    return 0;
  }

  const worktreesBefore = record.repo ? worktreePaths(record.repo) : [];
  record.env_stripped = strippedEnv();
  appendBoard(root, record);
  preflight(root, record);

  const timeoutMs = Math.max(30, Number(opts.timeout || 1800)) * 1000;
  const res = run(args, { cwd, timeout: timeoutMs, allowError: true });
  const endedAt = new Date();

  fs.writeFileSync(path.join(runDir, 'stdout.log'), res.out || '', 'utf8');
  fs.writeFileSync(path.join(runDir, 'stderr.log'), res.err || '', 'utf8');

  const payload = extractJson(res.out);
  const transcript = payload ? String(payload.result ?? payload.text ?? JSON.stringify(payload)) : res.out;
  const { result: roleResult, summary } = parseRoleResult(transcript);

  if (record.repo) {
    const after = worktreePaths(record.repo);
    const created = after.filter((p) => !worktreesBefore.includes(p));
    if (created.length) record.worktree = created[created.length - 1];
  }

  record.ended_at = endedAt.toISOString();
  record.duration_ms = endedAt - startedAt;
  record.exit_code = res.code;
  record.signal = res.signal || null;
  record.cli_version = record.cli_version || null;
  record.subtype = payload?.subtype ?? null;
  record.stop_reason = payload?.stop_reason ?? null;
  record.summary = summary || (payload && payload.result ? String(payload.result).split(/\r?\n/)[0].slice(0, 200) : null);
  record.role_result = roleResult || null;
  record.session_id = payload?.session_id || payload?.sessionId || record.session_id;
  record.model_used = payload?.model || (payload && payload.modelUsage ? Object.keys(payload.modelUsage).join(',') : record.model);
  record.cost_usd = payload?.total_cost_usd ?? null;
  record.credits = payload?.total_credits ?? null;
  record.turns = payload?.num_turns ?? payload?.turns ?? null;
  record.permission_denials = Array.isArray(payload?.permission_denials) ? payload.permission_denials.length : null;
  record.stderr_tail = res.err ? res.err.split(/\r?\n/).slice(-10).join('\n') : null;

  const combined = `${res.out}\n${res.err}`;
  let exitCode = 0;

  if (/sdk_worker_removed|sdk_invalid_args/i.test(combined)) {
    record.status = 'failed';
    record.error = 'qoder entered Agent SDK mode instead of headless (-p) mode';
    exitCode = 6;
    process.stderr.write('qoder-role-task: qoder refused headless mode and demanded Agent SDK mode.\n');
    process.stderr.write(`  cli: ${record.cli_version || QODER.label}\n`);
    process.stderr.write(`  stripped: ${(record.env_stripped || []).join(', ') || 'none'}\n`);
    process.stderr.write('  fix: a parent shell is exporting a Qoder SDK entrypoint variable;\n');
    process.stderr.write('       run from a clean shell, or unset QODER_AGENT_SDK_ENTRYPOINT.\n');
  } else if (res.error && (res.error.code === 'ETIMEDOUT' || res.signal)) {
    record.status = 'timeout';
    record.error = `run exceeded ${Math.round(timeoutMs / 1000)}s`;
    exitCode = 5;
    process.stderr.write(`qoder-role-task: ${record.error}\n`);
  } else if (res.error) {
    record.status = 'failed';
    record.error = `could not run qoder: ${res.error.message}`;
    exitCode = 1;
    process.stderr.write(`qoder-role-task: ${record.error}\n`);
  } else if (res.code !== 0) {
    record.status = 'failed';
    record.error = `qoder exited ${res.code}`;
    exitCode = 1;
    process.stderr.write(`qoder-role-task: qoder exited ${res.code}\n${record.stderr_tail || ''}\n`);
    process.stderr.write(`  transcript: ${path.join(runDir, 'stdout.log')}\n`);
  } else if (payload && payload.is_error) {
    record.status = 'failed';
    record.error = `qoder reported is_error (subtype ${payload.subtype || 'unknown'})`;
    exitCode = 1;
    process.stderr.write(`qoder-role-task: ${record.error}\n`);
  } else {
    record.status = roleResult || 'done';
    exitCode = record.status === 'review' ? 3 : record.status === 'blocked' ? 4 : 0;
  }

  fs.writeFileSync(path.join(runDir, 'meta.json'),
    JSON.stringify({ ...record, transcript_tail: transcript.slice(-4000) }, null, 2), 'utf8');
  appendBoard(root, record);

  if (exitCode === 0 || exitCode === 3 || exitCode === 4) {
    if (opts.json) process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    else {
      process.stdout.write(
        `run ${runId}  role=${role}  status=${record.status}\n` +
        `title: ${record.title}\n` +
        `workspace: ${record.worktree || cwd}${record.branch ? ` (branch ${record.branch})` : ''}\n` +
        `session: ${record.session_id || '-'}  (inspect with: qoder -r ${record.session_id || '<id>'} -w ${record.worktree || cwd})\n` +
        `summary: ${record.summary || '(none reported)'}\n` +
        `cost: ${record.credits ?? '-'} credits  turns: ${record.turns ?? '-'}  denials: ${record.permission_denials ?? '-'}\n` +
        `ledger: ${path.join(root, 'board.jsonl')}  |  run dir: ${runDir}\n`);
      if (transcript) process.stdout.write(`\n--- output tail ---\n${transcript.slice(-2000)}\n`);
    }
    if (exitCode === 4) process.stderr.write(`\n--- stderr tail ---\n${record.stderr_tail || '(empty)'}\n`);
  }
  return exitCode;
}

let code = 0;
try { code = main(); } catch (err) {
  process.stderr.write(`qoder-role-task: ${err && err.message ? err.message : err}\n`);
  code = 1;
}
process.exit(code);
