#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const args = new Map();
const positional = [];
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  const next = process.argv[i + 1];
  if (key === '--') {
    positional.push(...process.argv.slice(i + 1));
    break;
  }
  if (key.startsWith('--')) {
    if (!next || next.startsWith('--')) {
      args.set(key.slice(2), 'true');
    } else {
      args.set(key.slice(2), next);
      i += 1;
    }
  } else {
    positional.push(key);
  }
}

const projectDir = resolve(args.get('project-dir') ?? process.cwd());
const sessionsRoot = resolve(projectDir, '.agents', 'sessions');
const ACTIVE_STATUSES = new Set(['running', 'waiting']);
const APPROVED_STATUSES = new Set(['approved', 'auto_approved']);
const SENSITIVE_WRITE_PATTERNS = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)secrets?\b/i,
  /(^|\/)credentials?\b/i,
  /(^|\/)private_key\b/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
];

const splitList = (raw = '') =>
  raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

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
      continue;
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

const normalizeProjectPath = (rawPath) => {
  const absolutePath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(projectDir, rawPath);
  const relativePath = relative(projectDir, absolutePath);
  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`Delete target is outside project: ${rawPath}`);
  }
  if (relativePath.startsWith('.agents/sessions/')) {
    throw new Error(`Harness artefacts cannot be deleted through this helper: ${rawPath}`);
  }
  return { absolutePath, relativePath };
};

const isSensitivePath = (relativePath) =>
  SENSITIVE_WRITE_PATTERNS.some((pattern) => pattern.test(relativePath));

const rawFiles = [...splitList(args.get('files')), ...positional];
if (rawFiles.length === 0) {
  throw new Error('Pass files with --files "a,b" or after --.');
}

const sessionDir = findActiveSession();
const { statePath, state } = readState(sessionDir);
const approvalStatus = state.approval?.status;
if (state.phase !== 'APPLY' || state.status !== 'running' || !APPROVED_STATUSES.has(approvalStatus)) {
  throw new Error(
    `Deletion requires APPLY running with approved approval in ${statePath} ` +
      `(phase=${state.phase}, status=${state.status}, approval=${approvalStatus ?? '<missing>'}).`,
  );
}

const allowedFiles = new Set(state.allowed_files ?? []);
if (allowedFiles.size === 0) {
  throw new Error(`APPLY phase has no allowed_files in ${statePath}.`);
}

const targets = rawFiles.map((file) => normalizeProjectPath(file));
for (const { relativePath } of targets) {
  if (!allowedFiles.has(relativePath)) {
    throw new Error(`Delete target is outside allowed_files: ${relativePath}`);
  }
  if (relativePath.startsWith('../rx-api-server/') || relativePath.includes('/../rx-api-server/')) {
    throw new Error(`Server repo target is not allowed: ${relativePath}`);
  }
  if (isSensitivePath(relativePath)) {
    throw new Error(`Sensitive file deletion is not allowed: ${relativePath}`);
  }
}

const dryRun = args.get('dry-run') === 'true';
const deleted = [];
const missing = [];
for (const { absolutePath, relativePath } of targets) {
  if (!existsSync(absolutePath)) {
    missing.push(relativePath);
    continue;
  }
  const stat = lstatSync(absolutePath);
  if (stat.isDirectory()) {
    throw new Error(`Refusing to delete directory: ${relativePath}`);
  }
  if (!dryRun) {
    unlinkSync(absolutePath);
  }
  deleted.push(relativePath);
}

process.stdout.write(
  `${JSON.stringify(
    {
      session_dir: sessionDir,
      state_path: statePath,
      dry_run: dryRun,
      [dryRun ? 'would_delete' : 'deleted']: deleted,
      missing,
    },
    null,
    2,
  )}\n`,
);
