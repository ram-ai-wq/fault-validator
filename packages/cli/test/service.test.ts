import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireLock,
  cancelRun,
  getRun,
  releaseLock,
  waitRun,
} from '../src/service.js';
import {
  deadPid,
  fakeProject,
  RUN_ID,
  removeFixtures,
  writeRun,
} from './fixtures.js';

afterEach(removeFixtures);

describe('run lock', () => {
  it('refuses a second run while the holder is alive', () => {
    const store = join(fakeProject(), '.test-container');
    acquireLock(store, 'run-a');
    expect(() => acquireLock(store, 'run-b')).toThrow(
      'TC_E_RUN_IN_PROGRESS: run run-a',
    );
  });

  it("takes over a lock whose holder is gone and fails that holder's run", () => {
    const root = fakeProject();
    const store = join(root, '.test-container');
    writeRun(root, { runtime: { mode: 'native', pid: deadPid() } });
    writeFileSync(
      join(store, 'lock'),
      JSON.stringify({ run_id: RUN_ID, pid: deadPid() }),
    );

    acquireLock(store, 'run-b');

    expect(getRun(root, RUN_ID).run.error?.code).toBe('TC_E_RUNNER_DIED');
    expect(JSON.parse(readFileSync(join(store, 'lock'), 'utf8'))).toMatchObject(
      { run_id: 'run-b' },
    );
  });

  it('replaces a dead holder that has no run folder', () => {
    const store = join(fakeProject(), '.test-container');
    writeFileSync(
      join(store, 'lock'),
      JSON.stringify({ run_id: 'old', pid: deadPid() }),
    );
    acquireLock(store, 'run-b');
    expect(JSON.parse(readFileSync(join(store, 'lock'), 'utf8'))).toMatchObject(
      { run_id: 'run-b' },
    );
  });

  it('keeps a lock that is still being written and replaces an abandoned one', () => {
    const store = join(fakeProject(), '.test-container');
    const lock = join(store, 'lock');
    writeFileSync(lock, '');
    expect(() => acquireLock(store, 'run-b')).toThrow('TC_E_RUN_IN_PROGRESS');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    acquireLock(store, 'run-b');
    expect(readFileSync(lock, 'utf8')).toContain('run-b');
  });

  it('releases only the lock of the given run', () => {
    const store = join(fakeProject(), '.test-container');
    acquireLock(store, 'run-a');
    releaseLock(store, 'run-b');
    expect(existsSync(join(store, 'lock'))).toBe(true);
    releaseLock(store, 'run-a');
    expect(existsSync(join(store, 'lock'))).toBe(false);
  });
});

describe('waiting for and cancelling runs', () => {
  it('turns a run whose runner died into an error instead of waiting forever', async () => {
    const root = fakeProject();
    writeRun(root, { runtime: { mode: 'native', pid: deadPid() } });
    acquireLock(join(root, '.test-container'), RUN_ID);

    const result = await waitRun(root, RUN_ID, 30);

    expect(result.run.status).toBe('error');
    expect(result.run.error?.code).toBe('TC_E_RUNNER_DIED');
    expect(getRun(root, RUN_ID).run.status).toBe('error');
    expect(existsSync(join(root, '.test-container', 'lock'))).toBe(false);
  });

  it('returns a still-running run when the wait time is over', async () => {
    const root = fakeProject();
    writeRun(root, { runtime: { mode: 'native', pid: process.pid } });

    expect((await waitRun(root, RUN_ID, 0)).run.status).toBe('running');
  });

  it('does not touch a finished run or the lock of another run', async () => {
    const root = fakeProject();
    writeRun(root, { status: 'done' });
    acquireLock(join(root, '.test-container'), 'other-run');

    expect((await cancelRun(root, RUN_ID)).status).toBe('done');
    expect(existsSync(join(root, '.test-container', 'lock'))).toBe(true);
  });

  it('cancels an active run and releases its lock', async () => {
    const root = fakeProject();
    writeRun(root, { runtime: { mode: 'native', pid: deadPid() } });
    acquireLock(join(root, '.test-container'), RUN_ID);

    expect((await cancelRun(root, RUN_ID)).status).toBe('cancelled');
    expect(getRun(root, RUN_ID).run.status).toBe('cancelled');
    expect(existsSync(join(root, '.test-container', 'lock'))).toBe(false);
  });
});
