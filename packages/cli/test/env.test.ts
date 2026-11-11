import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@scope/core';
import { afterEach, describe, expect, it } from 'vitest';
import { getEnv } from '../src/service.js';

describe('test environment', () => {
  const folders: string[] = [];

  afterEach(() => {
    for (const folder of folders.splice(0))
      rmSync(folder, { recursive: true, force: true });
  });

  function projectRoot(): string {
    const folder = mkdtempSync(join(tmpdir(), 'tc-env-'));
    folders.push(folder);
    return folder;
  }

  it('resolves the env file from the project root and applies precedence', () => {
    const root = projectRoot();
    writeFileSync(
      join(root, '.env.qa'),
      'ENV=file\nREGION=file\nAPI_TOKEN=from-file\n',
    );
    const config = parseConfig(
      'env:\n  envFile: .env.qa\n  passthrough: [REGION, API_TOKEN, UNSET]\n',
    );

    const env = getEnv(config, { ENV: 'cli' }, root, {
      REGION: 'shell',
      API_TOKEN: 'from-shell',
    });

    // --env beats the shell, the shell beats the file, and the file cannot
    // supply secret-named variables.
    expect(env).toEqual({
      ENV: 'cli',
      REGION: 'shell',
      API_TOKEN: 'from-shell',
    });
  });

  it('rejects secret-named values supplied on the command line', () => {
    expect(() =>
      getEnv(parseConfig(''), { API_TOKEN: 'x' }, projectRoot(), {}),
    ).toThrow('TC_E_CONFIG_INVALID: API_TOKEN');
  });

  it('rejects names that change how the runner and its tools start', () => {
    for (const name of [
      'TC_MODE',
      'tc_run_dir',
      'PATH',
      'Path',
      'NODE_OPTIONS',
      'BUN_OPTIONS',
      'LD_PRELOAD',
      'DYLD_INSERT_LIBRARIES',
      'DOCKER_HOST',
      'CONTAINER_HOST',
    ]) {
      expect(() =>
        getEnv(parseConfig(''), { [name]: 'x' }, projectRoot(), {}),
      ).toThrow(`TC_E_CONFIG_INVALID: ${name} is reserved`);
    }
    expect(
      getEnv(
        parseConfig(''),
        { NODE_ENV: 'qa', NODE_TLS_REJECT_UNAUTHORIZED: '0' },
        projectRoot(),
        {},
      ),
    ).toEqual({ NODE_ENV: 'qa', NODE_TLS_REJECT_UNAUTHORIZED: '0' });
  });

  it('rejects names that are not valid variable names', () => {
    expect(() =>
      getEnv(parseConfig(''), { 'A=B': 'x' }, projectRoot(), {}),
    ).toThrow('is not a valid environment variable name');
  });
});
