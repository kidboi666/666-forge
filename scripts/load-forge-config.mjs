import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export const loadForgeConfig = (projectDir) => {
  const configPath = resolve(projectDir, '.forge.json');
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    process.stderr.write(`[forge-config] .forge.json 파싱 실패: ${error.message}\n`);
    return {};
  }
};

export const resolveProtectedPaths = (projectDir, config) => {
  const raw = config?.protected_paths;
  if (!Array.isArray(raw)) return [];
  const resolved = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim() === '') continue;
    const absolutePath = isAbsolute(entry) ? resolve(entry) : resolve(projectDir, entry);
    resolved.push(absolutePath);
  }
  return resolved;
};

export const isInsideAny = (target, roots) => {
  for (const root of roots) {
    if (target === root || target.startsWith(`${root}/`) || target.startsWith(`${root}\\`)) {
      return root;
    }
  }
  return null;
};
