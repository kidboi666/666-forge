#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { loadForgeConfig } from './load-forge-config.mjs';

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
const skipInstall = args.get('skip-install') === 'true';

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

const detectPackageManager = (dir) => {
  if (existsSync(resolve(dir, 'pnpm-lock.yaml'))) {
    return { name: 'pnpm', command: 'pnpm', args: ['install'] };
  }
  if (existsSync(resolve(dir, 'yarn.lock'))) {
    return { name: 'yarn', command: 'yarn', args: ['install'] };
  }
  if (existsSync(resolve(dir, 'bun.lockb')) || existsSync(resolve(dir, 'bun.lock'))) {
    return { name: 'bun', command: 'bun', args: ['install'] };
  }
  if (existsSync(resolve(dir, 'package-lock.json'))) {
    return { name: 'npm', command: 'npm', args: ['install'] };
  }
  return null;
};

const ensureNodeModules = () => {
  if (skipInstall) return;
  if (!existsSync(resolve(projectDir, 'package.json'))) return;
  if (existsSync(resolve(projectDir, 'node_modules'))) return;
  const pm = detectPackageManager(projectDir);
  if (!pm) {
    process.stderr.write(
      `[init-harness-session] node_modules 누락 상태이지만 패키지 매니저 lockfile을 찾을 수 없습니다 (${projectDir}). 의존성을 수동 설치 후 다시 시도하세요.\n`,
    );
    return;
  }
  process.stderr.write(
    `[init-harness-session] node_modules 누락 — ${pm.name} install을 실행합니다 (${projectDir}).\n`,
  );
  const result = spawnSync(pm.command, pm.args, { cwd: projectDir, stdio: 'inherit' });
  if (result.error) {
    throw new Error(
      `[init-harness-session] ${pm.name} install 실행 실패: ${result.error.message}. ` +
        '의존성을 직접 설치하거나 --skip-install 플래그로 우회하세요.',
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `[init-harness-session] ${pm.name} install 종료 코드 ${result.status}. ` +
        '의존성을 직접 설치하거나 --skip-install 플래그로 우회하세요.',
    );
  }
};

ensureNodeModules();

const detectVerifyCommands = () => {
  const config = loadForgeConfig(projectDir);
  const fromConfig = {
    typecheck: config?.verify?.typecheck ?? null,
    test: config?.verify?.test ?? null,
  };
  if (fromConfig.typecheck && fromConfig.test) {
    return fromConfig;
  }
  const packageJsonPath = resolve(projectDir, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return fromConfig;
  }
  let scripts = {};
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    scripts = pkg.scripts ?? {};
  } catch {
    return fromConfig;
  }
  const pm = detectPackageManager(projectDir);
  if (!pm) return fromConfig;
  const runner = pm.name === 'npm' ? 'npm run' : pm.name;
  const typecheckScript = ['typecheck', 'type-check', 'tsc', 'check-types'].find(
    (name) => scripts[name],
  );
  const testScript = ['test:related', 'test'].find((name) => scripts[name]);
  return {
    typecheck: fromConfig.typecheck ?? (typecheckScript ? `${runner} ${typecheckScript}` : null),
    test: fromConfig.test ?? (testScript ? `${runner} ${testScript}` : null),
  };
};

const verifyCommands = detectVerifyCommands();

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
  verify_commands: verifyCommands,
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
