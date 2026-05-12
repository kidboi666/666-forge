#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

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

const projectDir = resolve(args.get('project-dir') ?? process.cwd());
const sessionsRoot = resolve(projectDir, '.agents', 'sessions');

const ACTIVE_STATUSES = new Set(['running', 'waiting']);
const VALID_PHASES = new Set(['GROUND', 'APPLY', 'VERIFY', 'ADAPT']);
const VALID_STATUSES = new Set(['running', 'waiting', 'completed', 'failed', 'stopped']);
const VALID_APPROVAL_STATUSES = new Set([
  'not_required',
  'pending',
  'approved',
  'auto_approved',
  'rejected',
]);
const VALID_DELEGATION_STATUSES = new Set(['idle', 'running', 'waiting', 'completed', 'failed']);

const readState = (sessionDir) => {
  const statePath = resolve(sessionDir, 'state.json');
  return { statePath, state: JSON.parse(readFileSync(statePath, 'utf8')) };
};

const findActiveSession = () => {
  const explicitDir = args.get('session-dir');
  if (explicitDir) {
    return resolve(explicitDir);
  }
  const explicitId = args.get('session-id');
  if (explicitId) {
    return resolve(sessionsRoot, explicitId);
  }
  const candidates = [];
  for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'manual') continue;
    const dir = resolve(sessionsRoot, entry.name);
    try {
      const { state } = readState(dir);
      if (ACTIVE_STATUSES.has(state.status)) {
        candidates.push({ dir, mtime: statSync(dir).mtimeMs });
      }
    } catch {
      // skip unreadable sessions
    }
  }
  if (candidates.length === 0) {
    throw new Error('No active harness session found (status running/waiting).');
  }
  if (candidates.length > 1) {
    const activeSessions = candidates.map((candidate) => candidate.dir).join(', ');
    throw new Error(
      `Multiple active harness sessions found. Pass --session-id explicitly: ${activeSessions}`,
    );
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].dir;
};

const splitList = (raw) =>
  raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

const sessionDir = findActiveSession();
const { statePath, state } = readState(sessionDir);

if (args.has('phase')) {
  const phase = args.get('phase');
  if (!VALID_PHASES.has(phase)) {
    throw new Error(`Invalid phase: ${phase}`);
  }
  state.phase = phase;
}
if (args.has('status')) {
  const status = args.get('status');
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
  state.status = status;
}
if (args.has('apply-state')) {
  const value = args.get('apply-state');
  state.apply_state = value === 'null' ? null : value;
}

if (args.has('approval-status')) {
  state.approval = state.approval ?? {
    status: 'not_required',
    selected_option: null,
    approved_at: null,
  };
  const status = args.get('approval-status');
  if (!VALID_APPROVAL_STATUSES.has(status)) {
    throw new Error(`Invalid approval status: ${status}`);
  }
  state.approval.status = status;
  if (status === 'approved' || status === 'auto_approved') {
    state.approval.approved_at = new Date().toISOString();
  } else {
    state.approval.approved_at = null;
  }
}
if (args.has('selected-option')) {
  state.approval = state.approval ?? {
    status: 'not_required',
    selected_option: null,
    approved_at: null,
  };
  state.approval.selected_option = args.get('selected-option');
}

if (args.has('allowed-files')) {
  state.allowed_files = splitList(args.get('allowed-files'));
}
if (args.has('add-allowed-files')) {
  const additions = splitList(args.get('add-allowed-files'));
  const merged = new Set(state.allowed_files ?? []);
  for (const file of additions) merged.add(file);
  state.allowed_files = Array.from(merged);
}

if (args.has('delegation-status')) {
  state.delegation = state.delegation ?? {
    status: 'idle',
    kind: null,
    started_at: null,
    result_file: null,
  };
  const status = args.get('delegation-status');
  if (!VALID_DELEGATION_STATUSES.has(status)) {
    throw new Error(`Invalid delegation status: ${status}`);
  }
  state.delegation.status = status;
  if (args.has('delegation-kind')) {
    state.delegation.kind = args.get('delegation-kind');
  }
  if (status === 'running' || status === 'waiting') {
    state.delegation.started_at = state.delegation.started_at ?? new Date().toISOString();
  }
  if (status === 'idle') {
    state.delegation.kind = null;
    state.delegation.started_at = null;
    state.delegation.result_file = null;
  }
}

if (args.has('delegation-result-file')) {
  state.delegation = state.delegation ?? {
    status: 'idle',
    kind: null,
    started_at: null,
    result_file: null,
  };
  state.delegation.result_file = args.get('delegation-result-file');
}

if (args.has('last-failure')) {
  const value = args.get('last-failure');
  state.last_failure = value === 'null' ? null : value;
}

const assertRelativeProjectPath = (file) => {
  if (isAbsolute(file)) {
    throw new Error(`allowed_files must be relative paths: ${file}`);
  }
  const normalized = relative(projectDir, resolve(projectDir, file));
  if (normalized.startsWith('..') || normalized === '') {
    throw new Error(`allowed_files entry is outside project or invalid: ${file}`);
  }
  if (normalized.startsWith('.agents/sessions/')) {
    throw new Error(`Harness artefacts are not valid app allowed_files entries: ${file}`);
  }
};

for (const file of state.allowed_files ?? []) {
  assertRelativeProjectPath(file);
}

if (state.phase === 'APPLY' && ACTIVE_STATUSES.has(state.status)) {
  if (!state.allowed_files || state.allowed_files.length === 0) {
    throw new Error('APPLY phase requires non-empty allowed_files.');
  }
  if (state.status === 'running') {
    const approval = state.approval?.status;
    if (approval !== 'approved' && approval !== 'auto_approved') {
      throw new Error('APPLY running requires approval.status approved or auto_approved.');
    }
  }
}

writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

process.stdout.write(
  `${JSON.stringify(
    {
      session_dir: sessionDir,
      state_path: statePath,
      state,
    },
    null,
    2,
  )}\n`,
);
