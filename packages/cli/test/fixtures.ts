import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunState } from '../src/service.js';

export const RUN_ID = '20260101-000000-aaaa';

const folders: string[] = [];

export function removeFixtures(): void {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
}

export function fakeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'tc-fixture-'));
  folders.push(root);
  writeFileSync(join(root, 'playwright.config.ts'), 'export default {};\n');
  mkdirSync(join(root, '.test-container'), { recursive: true });
  return root;
}

export function writeRun(
  root: string,
  overrides: Partial<RunState> = {},
  id = RUN_ID,
): string {
  const dir = join(root, '.test-container', 'runs', id);
  mkdirSync(dir, { recursive: true });
  const run: RunState = {
    id,
    status: 'running',
    phase: 'execute',
    request: {
      tags: ['@a'],
      match: 'any',
      projects: [],
      workers: 1,
      rerunAttempts: 0,
      runtime: 'native',
      projectRoot: root,
      workdir: root,
      envNames: [],
    },
    runtime: { mode: 'native' },
    versions: { playwright: '1.0.0', testContainer: '0.1.0', node: 'v0' },
    counters: { selected: 4, done: 2, passed: 2, failed: 0, skipped: 0 },
    startedAt: new Date().toISOString(),
    ...overrides,
  };
  writeFileSync(join(dir, 'run.json'), JSON.stringify(run));
  writeFileSync(join(root, '.test-container', 'latest'), `${id}\n`);
  return dir;
}

// The pid of a process that has already exited.
export function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '0']);
  if (!child.pid) throw new Error('Could not start a helper process.');
  return child.pid;
}
