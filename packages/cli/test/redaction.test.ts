import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeLocation, redactRunArtifacts } from '../src/runner.js';

describe('redactRunArtifacts', () => {
  it('redacts text and JSON files and leaves binary archives untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-redact-'));
    const secret = 'unit-test-secret-value';
    try {
      mkdirSync(join(dir, 'logs'));
      writeFileSync(
        join(dir, 'logs', 'runner.log'),
        `token=${secret}\nPlaywright printed ${secret}`,
      );
      writeFileSync(
        join(dir, 'failures.json'),
        JSON.stringify({
          error: { message: `Authorization: Bearer ${secret}` },
          count: 3,
        }),
      );
      writeFileSync(join(dir, 'trace.zip'), `PK ${secret}`);

      redactRunArtifacts(dir, [secret]);

      expect(readFileSync(join(dir, 'logs', 'runner.log'), 'utf8')).toBe(
        'token=[REDACTED]\nPlaywright printed [REDACTED]',
      );
      expect(
        JSON.parse(readFileSync(join(dir, 'failures.json'), 'utf8')),
      ).toEqual({ error: { message: 'Authorization: [REDACTED]' }, count: 3 });
      expect(readFileSync(join(dir, 'trace.zip'), 'utf8')).toContain(secret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('composeLocation', () => {
  it('turns a Windows path into a literal forward-slash pattern', () => {
    expect(composeLocation('C:\\work\\My App (v2)\\tests\\a.spec.ts', 12)).toBe(
      'C:/work/My App \\(v2\\)/tests/a\\.spec\\.ts:12',
    );
  });

  it('matches the original path the way Playwright applies it', () => {
    const path = 'C:\\work\\app+x\\tests\\a.spec.ts';
    const pattern = composeLocation(path, 3).replace(/:3$/, '');
    const unixPath = path.replaceAll('\\', '/');
    expect(new RegExp(pattern, 'gi').test(unixPath)).toBe(true);
  });
});
