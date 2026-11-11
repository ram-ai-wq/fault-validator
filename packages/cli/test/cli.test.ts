import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/index.js';
import { javascriptArgs } from '../src/runtime.js';
import { fakeProject, RUN_ID, removeFixtures, writeRun } from './fixtures.js';

describe('test-container CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    removeFixtures();
  });

  it('keeps Bun subprocesses from loading unapproved env files or packages', () => {
    expect(javascriptArgs(['runner.cjs', 'pipeline'], '1.4.4')).toEqual([
      '--no-env-file',
      '--no-install',
      'runner.cjs',
      'pipeline',
    ]);
    expect(javascriptArgs(['runner.cjs', 'pipeline'], '')).toEqual([
      'runner.cjs',
      'pipeline',
    ]);
  });

  it('prints the package version', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await runCli(['--version'])).toBe(0);
    expect(log).toHaveBeenCalledWith('test-container v0.1.0');
  });

  it('prints usage when requested', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await runCli(['--help'])).toBe(0);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('Usage: test-container <command>'),
    );
  });

  it('rejects unknown commands', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runCli(['invalid'])).toBe(2);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('TC_E_CONFIG_INVALID: unknown command invalid.'),
    );
  });

  it('rejects --timeout without --wait', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runCli(['run', '--tags', '@a', '--timeout', '5'])).toBe(2);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('--timeout only applies with --wait'),
    );
  });

  it('refuses to initialize a folder that does not exist', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const missing = join(fakeProject(), 'missing');

    expect(await runCli(['init', '--write', '--project-root', missing])).toBe(
      2,
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('TC_E_PROJECT_NOT_FOUND'),
    );
  });

  describe('wait exit codes', () => {
    const wait = (root: string) =>
      runCli(['wait', '--project-root', root, '--timeout', '0']);

    it('exits 0 and prints the summary when the run is done', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const root = fakeProject();
      writeFileSync(
        join(writeRun(root, { status: 'done' }), 'summary.md'),
        'summary text',
      );

      expect(await wait(root)).toBe(0);
      expect(log).toHaveBeenCalledWith('summary text');
    });

    it.each([
      ['TC_E_PLAYWRIGHT_CRASH', 4],
      ['TC_E_RUNNER_DIED', 4],
      ['TC_E_ENGINE_UNAVAILABLE', 3],
      ['TC_E_NO_TESTS', 2],
    ])('maps the run error %s to exit %i', async (code, exit) => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const root = fakeProject();
      writeRun(root, {
        status: 'error',
        error: { code, message: 'failed', fix: 'retry' },
      });

      expect(await wait(root)).toBe(exit);
      expect(error).toHaveBeenCalledWith(expect.stringContaining(code));
    });

    it('exits 4 for a cancelled run', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const root = fakeProject();
      writeRun(root, { status: 'cancelled' });

      expect(await wait(root)).toBe(4);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('TC_E_RUN_CANCELLED'),
      );
    });

    it('exits 4 when the run is still going after the wait limit', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const root = fakeProject();
      writeRun(root, { runtime: { mode: 'native', pid: process.pid } });

      expect(await wait(root)).toBe(4);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(`TC_E_WAIT_TIMEOUT: run ${RUN_ID}`),
      );
    });
  });

  it('reads another project with --project-root on any command', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const root = fakeProject();
    writeFileSync(
      join(writeRun(root, { status: 'done' }), 'summary.md'),
      'summary text',
    );

    expect(await runCli(['summary', RUN_ID, '--project-root', root])).toBe(0);
    expect(log).toHaveBeenCalledWith('summary text');
    expect(await runCli(['runs', '--project-root', root])).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(RUN_ID));
  });
});
