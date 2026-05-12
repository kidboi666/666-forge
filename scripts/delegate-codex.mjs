#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  const next = process.argv[i + 1];
  if (key.startsWith('--')) {
    if (!next || next.startsWith('--')) {
      args.set(key.slice(2), 'true');
    } else {
      args.set(key.slice(2), next);
      i += 1;
    }
  }
}

const cwd = resolve(args.get('cwd') ?? process.cwd());
const mode = args.get('mode') ?? 'read-only';

if (!['read-only', 'convention-review', 'convention-fix', 'adapt-review'].includes(mode)) {
  throw new Error(`Unsupported mode: ${mode}`);
}

const ACTIVE_STATUSES = new Set(['running', 'waiting']);
const sessionsRoot = resolve(cwd, '.agents', 'sessions');

const readSessionState = (dir) => {
  const statePath = resolve(dir, 'state.json');
  if (!existsSync(statePath)) {
    throw new Error(`Harness session state not found: ${statePath}`);
  }
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read harness session state: ${statePath}`);
  }
};

const assertActiveSession = (dir) => {
  const state = readSessionState(dir);
  if (!ACTIVE_STATUSES.has(state.status)) {
    throw new Error(
      `Harness session is not active: ${state.session_id ?? dir} (status=${state.status})`,
    );
  }
  return dir;
};

const findActiveSessionDir = () => {
  if (!existsSync(sessionsRoot)) {
    throw new Error('No harness sessions directory found. Start /forge:harness first.');
  }
  const candidates = [];
  for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'manual') continue;
    const dir = resolve(sessionsRoot, entry.name);
    const statePath = resolve(dir, 'state.json');
    if (!existsSync(statePath)) continue;
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      if (ACTIVE_STATUSES.has(state.status)) {
        candidates.push(dir);
      }
    } catch {
      // skip
    }
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw new Error('No active harness session found. Pass --session-id or start /forge:harness first.');
  }
  throw new Error(
    `Multiple active harness sessions found. Pass --session-id explicitly: ${candidates.join(', ')}`,
  );
};

const explicitSessionDir = args.get('session-dir');
const explicitSessionId = args.get('session-id');
let sessionDir;
if (explicitSessionDir && explicitSessionId) {
  throw new Error('Pass only one of --session-id or --session-dir.');
}
if (explicitSessionId) {
  sessionDir = assertActiveSession(resolve(sessionsRoot, explicitSessionId));
} else if (explicitSessionDir) {
  sessionDir = assertActiveSession(resolve(explicitSessionDir));
} else {
  sessionDir = assertActiveSession(findActiveSessionDir());
}

const DEFAULT_OUTPUT_BY_MODE = {
  'read-only': 'codex-ground.md',
  'convention-review': 'codex-convention-review.md',
  'convention-fix': 'codex-convention-fix.md',
  'adapt-review': 'codex-adapt-review.md',
};

const output = resolve(args.get('output') ?? `${sessionDir}/${DEFAULT_OUTPUT_BY_MODE[mode]}`);
const debugLog = resolve(args.get('debug-log') ?? `${sessionDir}/codex-debug-${mode}.log`);
const promptFile = args.get('prompt-file');
const promptText = args.get('prompt');
const writeScope = (args.get('write-scope') ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

if (mode === 'convention-fix' && writeScope.length === 0) {
  throw new Error('convention-fix mode requires --write-scope');
}

mkdirSync(sessionDir, { recursive: true });
mkdirSync(dirname(output), { recursive: true });
mkdirSync(dirname(debugLog), { recursive: true });

const STALE_LOCK_MS = 30 * 60 * 1000;

const isProcessAlive = (pid) => {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
};

const lockPath = `${sessionDir}/codex.lock`;
if (existsSync(lockPath)) {
  let stale = false;
  let reason = '';
  try {
    const lockData = JSON.parse(readFileSync(lockPath, 'utf8'));
    const startedAt = lockData.started_at ? Date.parse(lockData.started_at) : NaN;
    const ageMs = Number.isFinite(startedAt) ? Date.now() - startedAt : Infinity;
    if (!isProcessAlive(lockData.pid)) {
      stale = true;
      reason = `pid ${lockData.pid ?? '<missing>'} not alive`;
    } else if (ageMs > STALE_LOCK_MS) {
      stale = true;
      reason = `lock older than ${Math.round(STALE_LOCK_MS / 60000)}m (age=${Math.round(ageMs / 60000)}m)`;
    }
  } catch {
    stale = true;
    reason = 'lock file unreadable';
  }
  if (stale) {
    process.stderr.write(`[delegate-codex] removing stale lock: ${reason}\n`);
    rmSync(lockPath, { force: true });
  } else {
    throw new Error(`Codex delegation is already running for this session: ${lockPath}`);
  }
}

const readPrompt = () => {
  if (promptFile) {
    return readFileSync(resolve(promptFile), 'utf8');
  }
  if (promptText) {
    return promptText;
  }
  throw new Error('Provide --prompt-file or --prompt');
};

const statePath = resolve(sessionDir, 'state.json');
const updateDelegation = (status, extra = {}) => {
  if (!existsSync(statePath)) {
    return;
  }
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || '';
  const helperScript = pluginRoot
    ? `${pluginRoot}/scripts/set-harness-phase.mjs`
    : '.claude/scripts/set-harness-phase.mjs';
  const helperArgs = [
    helperScript,
    '--session-dir',
    sessionDir,
    '--delegation-status',
    status,
    '--delegation-kind',
    mode,
  ];
  if (extra.resultFile) {
    helperArgs.push('--delegation-result-file', extra.resultFile);
  }
  const result = spawnSync(process.execPath, helperArgs, {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `Failed to update delegation state: ${(result.stderr || result.stdout || '').trim()}`,
    );
  }
};

const listChangedFiles = () => {
  const result = spawnSync('git', ['-C', cwd, 'status', '--short'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
};

const isAllowedWrite = (file) => {
  if (file.startsWith('../rx-api-server/') || file.includes('/../rx-api-server/')) {
    return false;
  }
  return writeScope.includes(file);
};

const fileFingerprint = (file) => {
  const absolutePath = resolve(cwd, file);
  if (!existsSync(absolutePath)) {
    return '__missing__';
  }
  if (!statSync(absolutePath).isFile()) {
    return '__directory__';
  }
  return createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
};

const snapshotChangedFiles = () => {
  const snapshot = new Map();
  for (const file of listChangedFiles()) {
    snapshot.set(file, fileFingerprint(file));
  }
  return snapshot;
};

const changedSince = (beforeSnapshot) => {
  const afterFiles = listChangedFiles();
  return afterFiles.filter((file) => beforeSnapshot.get(file) !== fileFingerprint(file));
};

const basePrompt = readPrompt();
const modePrompt = [
  `Mode: ${mode}`,
  'Project policy: read AGENTS.md and relevant .claude/rules/*.md. Do not duplicate or override them.',
  'Execution model: this is a serial delegation. Return a concise result for Claude Code to synthesize.',
  mode === 'convention-fix'
    ? `Write scope: only these files may be edited: ${writeScope.join(', ')}. Do not change logic intent.`
    : 'Read-only: do not edit files.',
  basePrompt,
].join('\n\n');

writeFileSync(
  lockPath,
  JSON.stringify({ mode, pid: process.pid, started_at: new Date().toISOString() }, null, 2),
);
updateDelegation('running');

const beforeSnapshot = snapshotChangedFiles();
try {
  const codexArgs = ['exec', '--full-auto', modePrompt];
  const result = spawnSync('codex', codexArgs, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
  });

  const stdoutText = (result.stdout ?? '').replace(/\s+$/u, '');
  const answer = stdoutText.length > 0 ? `${stdoutText}\n` : '';
  writeFileSync(output, answer);

  const debugTranscript = [
    `mode: ${mode}`,
    `status: ${result.status === 0 ? 'success' : 'failed'}`,
    `exit_code: ${result.status ?? 'null'}`,
    `recorded_at: ${new Date().toISOString()}`,
    '',
    '----- stdout -----',
    result.stdout ?? '',
    '----- stderr -----',
    result.stderr ?? '',
  ].join('\n');
  writeFileSync(debugLog, debugTranscript);

  const changedByCodex = changedSince(beforeSnapshot);
  if (mode !== 'convention-fix' && changedByCodex.length > 0) {
    throw new Error(
      'Read-only Codex delegation changed the working tree. Inspect the diff before continuing.',
    );
  }
  if (mode === 'convention-fix') {
    const outsideScope = changedByCodex.filter((file) => !isAllowedWrite(file));
    if (outsideScope.length > 0) {
      throw new Error(`Codex modified files outside write scope: ${outsideScope.join(', ')}`);
    }
  }

  if (result.status !== 0) {
    updateDelegation('failed', { resultFile: output });
    process.exitCode = result.status ?? 1;
  } else {
    updateDelegation('completed', { resultFile: output });
  }
} catch (error) {
  updateDelegation('failed', { resultFile: output });
  throw error;
} finally {
  rmSync(lockPath, { force: true });
}
