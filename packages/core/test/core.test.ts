import { describe, expect, it } from 'vitest';
import {
  classifyFailure,
  createSignature,
  groupFailures,
  isSecretName,
  parseAriaSnapshot,
  parseConfig,
  parseError,
  parseKnownIssues,
  parseRules,
  redactText,
  secretValues,
  suggestLocator,
} from '../src/index.js';

describe('secret redaction', () => {
  it('treats only secret-named variables as secrets', () => {
    expect(
      secretValues({
        ENV: 'qa-environment',
        API_TOKEN: 't0k3n-value',
        USER_PASSWORD: 'p@ssw0rd!',
        SESSION_TIMEOUT: '30',
        DB_PASS: 'xx',
      }),
    ).toEqual(['t0k3n-value', 'p@ssw0rd!']);
    expect(isSecretName('CUSTOM_ID', '(?i)custom')).toBe(true);
    expect(isSecretName('ENV')).toBe(false);
  });

  it('matches whole name parts in the default pattern', () => {
    for (const name of [
      'API_KEY',
      'DB_PASSWORD',
      'AUTH_TOKEN',
      'SESSION_ID',
      'COOKIES',
      'password',
    ])
      expect(isSecretName(name), name).toBe(true);
    for (const name of ['AUTHOR', 'KEYCLOAK_URL', 'PASSENGER', 'NODE_ENV'])
      expect(isSecretName(name), name).toBe(false);
  });

  it('redacts entire header values, including quoted and cookie lists', () => {
    expect(redactText('Authorization: Bearer abc.def')).toBe(
      'Authorization: [REDACTED]',
    );
    expect(redactText('Cookie: sid=1; theme=dark')).toBe('Cookie: [REDACTED]');
    expect(redactText('Cookie: a="b c"; d=SECRET')).toBe('Cookie: [REDACTED]');
    expect(redactText('{"authorization":"Bearer abc","accept":"json"}')).toBe(
      '{"authorization":"[REDACTED]","accept":"json"}',
    );
    expect(redactText('{"cookie":"a=1; b=2","accept":"json"}')).toBe(
      '{"cookie":"[REDACTED]","accept":"json"}',
    );
    expect(redactText("{'authorization': 'Bearer abc def'}")).toBe(
      "{'authorization': '[REDACTED]'}",
    );
  });

  it('redacts URL credentials and bare JSON web tokens', () => {
    expect(redactText('GET https://ana:hunter2@example.com/p?x=1')).toBe(
      'GET https://ana:[REDACTED]@example.com/p?x=1',
    );
    expect(redactText('http://localhost:3000/a@b')).toBe(
      'http://localhost:3000/a@b',
    );
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r';
    expect(redactText(`seen ${jwt} in body`)).toBe('seen [REDACTED] in body');
  });

  it('redacts secret-named pairs and keeps the quoting', () => {
    expect(redactText('{"user":"ana","password":"hunter2"}')).toBe(
      '{"user":"ana","password":"[REDACTED]"}',
    );
    expect(redactText('failed with DB_PASSWORD=hunter2&retry=1')).toBe(
      'failed with DB_PASSWORD=[REDACTED]&retry=1',
    );
    expect(redactText('GET /api?access_token=abc&page=2')).toBe(
      'GET /api?access_token=[REDACTED]&page=2',
    );
  });

  it('leaves unrelated text alone and is idempotent', () => {
    const text =
      'tests 7 | passed 2\nLocator: getByLabel(\'Password\')\n{"passed": 2}';
    expect(redactText(text)).toBe(text);
    const once = redactText('password: hunter2 Cookie: a=1; b=2');
    expect(once).toBe('password: [REDACTED] Cookie: [REDACTED]');
    expect(redactText(once)).toBe(once);
  });

  it('redacts a longer secret before the shorter one it contains', () => {
    expect(redactText('abcdef and abc', ['abc', 'abcdef'])).toBe(
      '[REDACTED] and [REDACTED]',
    );
  });
});

describe('error normalization and classification', () => {
  it('recognizes network errors after stripping ANSI codes', () => {
    const error = parseError(
      '\u001b[31mError: page.goto: net::ERR_CONNECTION_REFUSED at https://localhost/login\u001b[0m',
    );
    expect(error.kind).toBe('navigation-network');
    expect(
      classifyFailure({
        id: '1',
        file: 'a.spec.ts',
        line: 1,
        project: 'chromium',
        title: 'login',
        tags: [],
        attempts: [{ status: 'failed' }],
        error,
      }).reason,
    ).toBe('env.network');
  });

  it('keeps timeouts without a locator out of the locator branch', () => {
    const plain = parseError('Test timeout of 30000ms exceeded.');
    expect(plain.kind).toBe('test-timeout');
    expect(
      parseError(
        'TimeoutError: page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "https://example.test/", waiting until "load"',
      ).kind,
    ).toBe('navigation-timeout');
    expect(
      parseError(
        "TimeoutError: locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Save' })",
      ).kind,
    ).toBe('locator-timeout');
    for (const locatorMissingAs of ['INCONCLUSIVE', 'BUG'] as const) {
      const result = classifyFailure(
        {
          id: '1',
          file: 'a.spec.ts',
          line: 1,
          project: 'chromium',
          title: 'slow test',
          tags: [],
          attempts: [{ status: 'failed' }],
          error: plain,
        },
        { locatorMissingAs },
      );
      expect(result.cls).toBe('INCONCLUSIVE');
      expect(result.reason).toBe('unknown');
    }
  });

  it('does not call an intercepted element a locator failure', () => {
    const error = parseError(
      "TimeoutError: locator.click: timeout\nwaiting for getByRole('button', { name: 'Save' })\nlocator resolved to <button>Save</button>\n<div class=\"loading\"> intercepts pointer events",
    );
    expect(error.resolved).toBe(true);
    expect(
      classifyFailure({
        id: '1',
        file: 'a.spec.ts',
        line: 1,
        project: 'chromium',
        title: 'save',
        tags: [],
        attempts: [{ status: 'failed' }],
        error,
      }).reason,
    ).toBe('env.loading-overlay');
  });

  it('classifies a failure that passes on retry as transient', () => {
    const failure = {
      id: '1',
      file: 'a.spec.ts',
      line: 1,
      project: 'chromium',
      title: 'save',
      tags: [],
      attempts: [{ status: 'failed' as const }, { status: 'passed' as const }],
      error: parseError('TimeoutError: locator.click: timeout'),
    };
    expect(classifyFailure(failure).cls).toBe('TRANSIENT');
  });

  it('does not treat a policy-skipped rerun as a changed failure', () => {
    const result = groupFailures(
      [
        {
          id: '1',
          file: 'a.spec.ts',
          line: 1,
          project: 'chromium',
          title: 'do not rerun',
          tags: ['@no-rerun'],
          attempts: [
            { status: 'failed' as const, error: 'Error: original failure' },
            {
              status: 'skipped' as const,
              error: 'Rerun skipped by tag @no-rerun.',
            },
          ],
          error: parseError('Error: original failure'),
        },
      ],
      'C:\\repo',
    );

    expect(result.failures[0].stable).toBe(true);
    expect(result.failures[0].attempts[1].status).toBe('skipped');
  });

  it('keeps signatures stable across volatile values but separates locators', () => {
    const first = parseError(
      "TimeoutError: locator.click: Timeout 10000ms exceeded.\nCall log:\nwaiting for getByRole('button', { name: 'Save' })",
    );
    const second = parseError(
      "TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\nwaiting for getByRole('button', { name: 'Save' })",
    );
    const third = parseError(
      "TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\nwaiting for getByRole('button', { name: 'Submit' })",
    );
    expect(createSignature(first, 'C:\\repo')).toBe(
      createSignature(second, 'C:\\repo'),
    );
    expect(createSignature(first, 'C:\\repo')).not.toBe(
      createSignature(third, 'C:\\repo'),
    );
  });

  it('groups matching failures deterministically', () => {
    const error = parseError('page.goto: net::ERR_CONNECTION_REFUSED');
    const result = groupFailures(
      ['a.spec.ts', 'b.spec.ts'].map((file, index) => ({
        id: String(index),
        file,
        line: 2,
        project: 'chromium',
        title: 'open page',
        tags: [],
        attempts: [{ status: 'failed' as const }],
        error,
      })),
      'C:\\repo',
    );
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].id).toBe('G1');
    expect(result.groups[0].testIds).toEqual(['0', '1']);
  });
});

describe('configuration, rules, and locator rescan', () => {
  it('loads defaults for an empty config', () => {
    const config = parseConfig('');
    expect(config.runtime).toBe('auto');
    expect(config.rerun.attempts).toBe(2);
    expect(config.rerun.noRerunTags).toEqual(['@no-rerun']);
  });

  it('rejects unknown keys at every level', () => {
    expect(() => parseConfig('bogus: true\n')).toThrow();
    expect(() => parseConfig('docker:\n  npmrc: .npmrc\n')).toThrow();
    expect(() => parseConfig('rerun:\n  attemps: 1\n')).toThrow();
  });

  it('validates rule regexes with the rule id in errors', () => {
    expect(() =>
      parseRules(
        "version: 1\nrules:\n  - id: broken-rule\n    class: BUG\n    reason: bug.test\n    confidence: 0.8\n    explain: broken\n    when:\n      all:\n        - message: '/[/'\n",
      ),
    ).toThrow('broken-rule');
  });

  it('matches known issues by path, title, and error', () => {
    const issues = parseKnownIssues(
      "version: 1\nissues:\n  - id: BUG-1\n    title: Known outage\n    match:\n      pathContains: reports/\n      titleContains: export\n      errorMatches: '/503/'\n",
    );
    expect(issues[0].id).toBe('BUG-1');
  });

  it('suggests a unique locator from an ARIA snapshot', () => {
    const snapshot = parseAriaSnapshot(
      '- main:\n  - button "Save order"\n  - button "Cancel"',
    );
    const suggestion = suggestLocator(
      {
        raw: "getByRole('button', { name: 'Save' })",
        kind: 'role',
        role: 'button',
        name: 'Save',
      },
      snapshot,
    );
    expect(suggestion?.locator).toContain('Save order');
    expect(suggestion?.unique).toBe(true);
  });

  it('classifies a renamed locator from the captured snapshot', () => {
    const failure = {
      id: '1',
      file: 'a.spec.ts',
      line: 1,
      project: 'chromium',
      title: 'save order',
      tags: [],
      attempts: [{ status: 'failed' as const }],
      error: parseError(
        "TimeoutError: locator.click: Timeout 10000ms exceeded.\nCall log:\nwaiting for getByRole('button', { name: 'Save' })",
      ),
      snapshot: parseAriaSnapshot(
        '- main:\n  - button "Save order"\n  - button "Cancel"',
      ),
    };

    const classification = classifyFailure(failure);
    expect(classification.cls).toBe('LOCATOR');
    expect(classification.reason).toBe('locator.renamed');
    expect(classification.suggestion?.locator).toContain('Save order');
    expect(
      groupFailures([failure], 'C:\\repo').groups[0].suggestion?.unique,
    ).toBe(true);
  });

  it('does not classify a duplicate locator candidate as a unique rescan', () => {
    const failure = {
      id: '1',
      file: 'a.spec.ts',
      line: 1,
      project: 'chromium',
      title: 'save order',
      tags: [],
      attempts: [{ status: 'failed' as const }],
      error: parseError(
        "TimeoutError: locator.click: Timeout 10000ms exceeded.\nCall log:\nwaiting for getByRole('button', { name: 'Save' })",
      ),
      snapshot: parseAriaSnapshot(
        '- main:\n  - button "Save order"\n  - button "Save order"',
      ),
    };

    const classification = classifyFailure(failure);
    expect(classification.cls).toBe('INCONCLUSIVE');
    expect(classification.reason).toBe('locator.missing');
  });

  it('retains a non-unique candidate for strict-mode locator failures', () => {
    const failure = {
      id: '1',
      file: 'a.spec.ts',
      line: 1,
      project: 'chromium',
      title: 'ambiguous save',
      tags: [],
      attempts: [{ status: 'failed' as const }],
      error: parseError(
        "strict mode violation: getByRole('button', { name: 'Save' }) resolved to 2 elements",
      ),
      snapshot: parseAriaSnapshot(
        '- main:\n  - button "Save"\n  - button "Save"',
      ),
    };

    const classification = classifyFailure(failure);
    expect(classification.cls).toBe('LOCATOR');
    expect(classification.suggestion?.unique).toBe(false);
  });
});
