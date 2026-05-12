#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

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
const projectSlug = basename(projectDir);
const task = args.get('task') ?? '';
const finalizeExisting = args.get('finalize-existing') === 'true';

const ACTIVE_STATUSES = new Set(['running', 'waiting']);

const findActiveSessions = () => {
  const sessionsRoot = resolve(projectDir, '.agents', 'sessions');
  if (!existsSync(sessionsRoot)) return [];
  const result = [];
  for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'manual') continue;
    const dir = resolve(sessionsRoot, entry.name);
    const statePath = resolve(dir, 'state.json');
    if (!existsSync(statePath)) continue;
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      if (ACTIVE_STATUSES.has(state.status)) {
        result.push({ dir, statePath, state });
      }
    } catch {
      // skip unreadable
    }
  }
  return result;
};

const activeSessions = findActiveSessions();
if (activeSessions.length > 0) {
  if (!finalizeExisting) {
    const ids = activeSessions.map((entry) => entry.state.session_id).join(', ');
    throw new Error(
      `Active harness session(s) already exist: ${ids}. ` +
        'Run with --finalize-existing to stop them, or close them via ' +
        '`node "${CLAUDE_PLUGIN_ROOT}/scripts/set-harness-phase.mjs" --session-id <id> --status stopped`.',
    );
  }
  for (const { state, statePath } of activeSessions) {
    state.status = 'stopped';
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}

const pad = (value) => String(value).padStart(2, '0');
const makeSessionId = () => {
  const now = new Date();
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
};

const sessionId = args.get('session-id') ?? makeSessionId();
const sessionDir = resolve(projectDir, '.agents', 'sessions', sessionId);

if (existsSync(sessionDir)) {
  throw new Error(`Harness session already exists: ${sessionDir}`);
}

mkdirSync(sessionDir, { recursive: true });

const state = {
  session_id: sessionId,
  phase: 'GROUND',
  status: 'running',
  task,
  project_dir: projectDir,
  project_slug: projectSlug,
  allowed_files: [],
  apply_state: null,
  approval: {
    status: 'not_required',
    selected_option: null,
    approved_at: null,
  },
  delegation: {
    status: 'idle',
    kind: null,
    started_at: null,
    result_file: null,
  },
  last_failure: null,
  failure_counts: {},
};

const files = new Map([
  ['state.json', `${JSON.stringify(state, null, 2)}\n`],
  ['failures.json', '{\n  "failures": []\n}\n'],
]);

for (const [name, contents] of files) {
  writeFileSync(resolve(sessionDir, name), contents);
}

process.stdout.write(
  `${JSON.stringify(
    {
      session_id: sessionId,
      session_dir: sessionDir,
      project_dir: projectDir,
      project_slug: projectSlug,
    },
    null,
    2,
  )}\n`,
);
