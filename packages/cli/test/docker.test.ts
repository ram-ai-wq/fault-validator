import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildRunArgs,
  fromContainerPath,
  getInstallPlan,
  installScript,
  toContainerPath,
} from '../src/docker.js';

const settings = {
  engine: 'docker' as const,
  image: 'auto',
  pull: 'if-missing' as const,
  extraArgs: ['--ipc=host'],
  hostGateway: true,
};

describe('docker runtime helpers', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
  });

  it('maps project paths into the container and back', () => {
    const root = join(tmpdir(), 'tc-project');
    const host = join(root, '.test-container', 'runs', 'r1', 'events.json');
    const inside = toContainerPath(host, root);

    expect(inside).toBe('/work/.test-container/runs/r1/events.json');
    expect(fromContainerPath(inside, root)).toBe(host);
    expect(() => toContainerPath(join(tmpdir(), 'other'), root)).toThrow(
      'TC_E_CONFIG_INVALID',
    );
  });

  it('passes environment variable names without values', () => {
    const args = buildRunArgs({
      settings,
      image: 'img',
      root: tmpdir(),
      toolDir: tmpdir(),
      workdir: tmpdir(),
      runId: 'r1',
      name: 'tc-r1',
      envNames: ['ENV', 'TC_MODE', 'ENV'],
      command: ['playwright', 'test'],
    });

    expect(args.filter((arg) => arg === '-e')).toHaveLength(2);
    expect(args).toContain('ENV');
    expect(args.some((arg) => /^ENV=/.test(arg))).toBe(false);
    expect(args.slice(-3)).toEqual(['img', 'playwright', 'test']);
  });

  it('chooses the installer from the lockfile', () => {
    const root = mkdtempSync(join(tmpdir(), 'tc-lock-'));
    dirs.push(root);
    writeFileSync(join(root, 'package.json'), '{}');
    expect(getInstallPlan(root, 'img').command).toContain('--no-package-lock');

    writeFileSync(join(root, 'bun.lock'), '{}');
    const bun = getInstallPlan(root, 'img');
    expect(bun.command).toContain('bun install --frozen-lockfile');
    expect(getInstallPlan(root, 'other').key).not.toBe(bun.key);
  });

  it('prefers Bun over a stale npm lock and honors an explicit manager', () => {
    const root = mkdtempSync(join(tmpdir(), 'tc-manager-'));
    dirs.push(root);
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(root, 'bun.lock'), '{}');
    writeFileSync(join(root, 'package-lock.json'), '{}');
    expect(getInstallPlan(root, 'img').lockfile).toBe('bun.lock');

    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ packageManager: 'npm@11.0.0' }),
    );
    expect(getInstallPlan(root, 'img').command).toContain('npm ci');

    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ packageManager: 'bun@1.4.4' }),
    );
    const plan = getInstallPlan(root, 'img');
    expect(plan.command).toContain('bun@1.4.4');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ packageManager: 'bun@1.4.5' }),
    );
    expect(getInstallPlan(root, 'img').key).not.toBe(plan.key);
  });

  it('ignores unknown package managers instead of failing', () => {
    const root = mkdtempSync(join(tmpdir(), 'tc-unknown-manager-'));
    dirs.push(root);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ packageManager: 'constructor@1' }),
    );
    writeFileSync(join(root, 'package-lock.json'), '{}');
    expect(getInstallPlan(root, 'img').lockfile).toBe('package-lock.json');
  });

  it('rejects missing Bun locks and non-exact Bun versions', () => {
    const root = mkdtempSync(join(tmpdir(), 'tc-bun-invalid-'));
    dirs.push(root);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ packageManager: 'bun@latest' }),
    );
    expect(() => getInstallPlan(root, 'img')).toThrow('requires bun.lock');
    writeFileSync(join(root, 'bun.lockb'), '{}');
    expect(() => getInstallPlan(root, 'img')).toThrow('exact version');
  });

  it('restores the Bun executable even when dependencies are cached', () => {
    const script = installScript({ command: 'npm ci', key: 'abc' }, '1.4.4');
    expect(script).toContain('fi\nif [ ! -x /work/node_modules/');
    expect(script).toContain('bun@1.4.4');
    expect(installScript({ command: 'npm ci', key: 'abc' })).not.toContain(
      'bun@',
    );
  });
});
