import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const failureClasses = [
  'TRANSIENT',
  'ENVIRONMENT',
  'LOCATOR',
  'TEST_ISSUE',
  'BUG',
  'KNOWN_ISSUE',
  'INCONCLUSIVE',
] as const;

export type FailureClass = (typeof failureClasses)[number];
export type ErrorKind =
  | 'locator-timeout'
  | 'locator-strict'
  | 'locator-detached'
  | 'action-intercepted'
  | 'action-not-actionable'
  | 'expect-element-missing'
  | 'expect-element-state'
  | 'expect-value'
  | 'expect-generic'
  | 'navigation-network'
  | 'navigation-timeout'
  | 'test-timeout'
  | 'hook-failure'
  | 'target-closed'
  | 'browser-crash'
  | 'js-error-in-test'
  | 'unexpected-pass'
  | 'api-response'
  | 'unknown';

export interface ParsedLocator {
  raw: string;
  kind:
    | 'role'
    | 'text'
    | 'label'
    | 'placeholder'
    | 'alt'
    | 'title'
    | 'testid'
    | 'css'
    | 'xpath'
    | 'unknown';
  role?: string;
  name?: string;
  exact?: boolean;
}

export interface NormalizedError {
  kind: ErrorKind;
  message: string;
  firstLine: string;
  locator?: ParsedLocator;
  matcher?: string;
  expected?: string;
  received?: string;
  resolved: boolean;
  topFrame?: { file: string; line: number };
}

export interface Attempt {
  status: 'passed' | 'failed' | 'timedOut' | 'interrupted' | 'skipped';
  error?: string;
}

export interface FailureInput {
  id: string;
  file: string;
  line: number;
  project: string;
  title: string;
  tags: string[];
  attempts: Attempt[];
  error: NormalizedError;
  signature?: string;
  snapshot?: AriaNode[];
  artifacts?: string[];
}

export interface Classification {
  cls: FailureClass;
  reason: string;
  confidence: number;
  ruleId: string;
  explain: string;
  suggestion?: LocatorSuggestion;
  hints?: string[];
}

export interface FailureRecord extends FailureInput {
  signature: string;
  stable: boolean;
  classification: Classification;
  groupId: string;
}

export interface Group {
  id: string;
  signature: string;
  cls: FailureClass;
  reason: string;
  confidence: number;
  testIds: string[];
  representativeId: string;
  explain: string;
  suggestion?: LocatorSuggestion;
  where?: { file: string; line: number };
}

export interface AriaNode {
  role: string;
  name: string;
  attrs: Record<string, string>;
  value?: string;
  children: AriaNode[];
  path: string[];
}

export interface LocatorSuggestion {
  locator: string;
  score: number;
  unique: boolean;
  candidates: Array<{ locator: string; score: number; unique: boolean }>;
}

// Matches whole name parts, so `API_TOKEN` and `DB_PASSWORD` are secrets while
// `AUTHOR` and `KEYCLOAK_URL` are not.
export const DEFAULT_SECRET_NAME_PATTERN =
  '(?i)(pass(word|wd|phrase|code)?|pwd|secret|token|key|auth(orization)?|cookie|session|cpf|cnpj)s?(?![a-z])';

// Replacing very short values everywhere would corrupt unrelated text, for
// example `30` from `SESSION_TIMEOUT=30`.
const MIN_SECRET_LENGTH = 6;

export const configSchema = z
  .object({
    version: z.literal(1).default(1),
    runtime: z.enum(['docker', 'native', 'auto']).default('auto'),
    workdir: z.string().default('.'),
    playwright: z
      .object({
        config: z.string().nullable().default(null),
        projects: z.array(z.string()).default([]),
        workers: z.number().int().min(1).max(32).default(2),
        extraArgs: z.array(z.string()).default([]),
        noRunTags: z.array(z.string()).default([]),
      })
      .strict()
      .default({
        config: null,
        projects: [],
        workers: 2,
        extraArgs: [],
        noRunTags: [],
      }),
    tags: z
      .object({ match: z.enum(['any', 'all']).default('any') })
      .strict()
      .default({ match: 'any' }),
    rerun: z
      .object({
        attempts: z.number().int().min(0).max(3).default(2),
        workers: z.number().int().min(1).max(32).default(1),
        backoffSeconds: z
          .array(z.number().int().min(0).max(3600))
          .default([10, 30]),
        noRerunTags: z.array(z.string()).default(['@no-rerun']),
      })
      .strict()
      .default({
        attempts: 2,
        workers: 1,
        backoffSeconds: [10, 30],
        noRerunTags: ['@no-rerun'],
      }),
    env: z
      .object({
        passthrough: z.array(z.string()).default([]),
        envFile: z.string().nullable().default(null),
      })
      .strict()
      .default({ passthrough: [], envFile: null }),
    docker: z
      .object({
        engine: z.enum(['docker', 'podman']).default('docker'),
        image: z.string().default('auto'),
        pull: z.enum(['always', 'if-missing', 'never']).default('if-missing'),
        extraArgs: z.array(z.string()).default(['--ipc=host']),
        hostGateway: z.boolean().default(true),
      })
      .strict()
      .default({
        engine: 'docker',
        image: 'auto',
        pull: 'if-missing',
        extraArgs: ['--ipc=host'],
        hostGateway: true,
      }),
    classification: z
      .object({
        envVar: z.string().default('ENV'),
        locatorThreshold: z.number().min(0).max(1).default(0.8),
        locatorMissingAs: z
          .enum(['INCONCLUSIVE', 'BUG'])
          .default('INCONCLUSIVE'),
        rules: z.string().default('test-container.rules.yml'),
        knownIssues: z.string().default('test-container.known-issues.yml'),
      })
      .strict()
      .default({
        envVar: 'ENV',
        locatorThreshold: 0.8,
        locatorMissingAs: 'INCONCLUSIVE',
        rules: 'test-container.rules.yml',
        knownIssues: 'test-container.known-issues.yml',
      }),
    report: z
      .object({
        maxSummaryTokens: z.number().int().positive().default(1500),
        maxGroupsInSummary: z.number().int().positive().default(15),
      })
      .strict()
      .default({ maxSummaryTokens: 1500, maxGroupsInSummary: 15 }),
    redaction: z
      .object({
        namePattern: z.string().default(DEFAULT_SECRET_NAME_PATTERN),
      })
      .strict()
      .default({ namePattern: DEFAULT_SECRET_NAME_PATTERN }),
  })
  .strict();

export type TestContainerConfig = z.infer<typeof configSchema>;

const ruleSchema = z
  .object({
    id: z.string().min(1),
    class: z.enum(failureClasses),
    reason: z.string().min(1),
    confidence: z.number().min(0).max(1),
    explain: z.string().max(500),
    when: z
      .object({
        any: z.array(z.record(z.string(), z.unknown())).optional(),
        all: z.array(z.record(z.string(), z.unknown())).optional(),
        not: z.array(z.record(z.string(), z.unknown())).optional(),
      })
      .strict(),
  })
  .strict();

const rulesSchema = z
  .object({ version: z.literal(1), rules: z.array(ruleSchema) })
  .strict();
const knownIssuesSchema = z.object({
  version: z.literal(1),
  issues: z.array(
    z.object({
      id: z.string().regex(/^[A-Za-z0-9._-]+$/),
      title: z.string(),
      link: z.string().url().optional(),
      env: z.array(z.string()).optional(),
      match: z
        .object({
          pathContains: z.string().optional(),
          titleContains: z.string().optional(),
          errorMatches: z.string().optional(),
        })
        .strict(),
    }),
  ),
});

export function parseConfig(source: string): TestContainerConfig {
  return configSchema.parse(parseYaml(source) ?? {});
}

export function parseRules(source: string) {
  const parsed = rulesSchema.parse(parseYaml(source));
  for (const rule of parsed.rules) {
    for (const condition of [
      ...(rule.when.all ?? []),
      ...(rule.when.any ?? []),
      ...(rule.when.not ?? []),
    ]) {
      for (const [field, pattern] of Object.entries(condition)) {
        if (typeof pattern === 'string' && pattern.startsWith('/'))
          compilePattern(pattern, `${rule.id}.${field}`);
      }
    }
  }
  return parsed.rules;
}

export function parseKnownIssues(source: string) {
  const parsed = knownIssuesSchema.parse(parseYaml(source));
  for (const issue of parsed.issues) {
    if (issue.match.errorMatches)
      compilePattern(issue.match.errorMatches, issue.id);
  }
  return parsed.issues;
}

function compilePattern(source: string, label: string): RegExp {
  const match = /^\/(.*)\/([dgimsuvy]*)$/.exec(source);
  try {
    return match ? new RegExp(match[1], match[2]) : new RegExp(source);
  } catch (error) {
    throw new Error(
      `Invalid regex in ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function matchPattern(source: string, value: string): boolean {
  const regex = compilePattern(source, 'condition');
  regex.lastIndex = 0;
  return regex.test(value);
}

export function parseLocator(source: string): ParsedLocator {
  const raw = source.trim();
  const match =
    /(?:getByRole|internal:role=)\s*\(?\s*['"]?([-\w]+)['"]?(?:\s*,\s*\{\s*name:\s*['"]([^'"]+)['"](?:,\s*exact:\s*(true|false))?)?/.exec(
      raw,
    );
  if (match)
    return {
      raw,
      kind: 'role',
      role: match[1],
      name: match[2],
      exact: match[3] === 'true',
    };
  for (const [kind, pattern] of [
    ['testid', /(?:getByTestId|internal:testid=)\s*\(?\s*['"]([^'"]+)['"]/],
    ['label', /getByLabel\s*\(\s*['"]([^'"]+)['"]/],
    ['placeholder', /getByPlaceholder\s*\(\s*['"]([^'"]+)['"]/],
    ['alt', /getByAltText\s*\(\s*['"]([^'"]+)['"]/],
    ['title', /getByTitle\s*\(\s*['"]([^'"]+)['"]/],
    ['text', /getByText\s*\(\s*['"]([^'"]+)['"]/],
    ['xpath', /(?:xpath=|locator\s*\(\s*['"])(\/\/[^'"]+)/],
    ['css', /(?:css=|locator\s*\(\s*['"])([^'"]+)/],
  ] as const) {
    const found = pattern.exec(raw);
    if (found) return { raw, kind, name: found[1] } as ParsedLocator;
  }
  return { raw, kind: 'unknown' };
}

// A timeout points at a locator only when the message names one. Waits for
// navigation or for the whole test to finish say nothing about locators.
function timeoutKind(message: string, locator?: ParsedLocator): ErrorKind {
  if (locator && locator.kind !== 'unknown') return 'locator-timeout';
  if (
    /\bpage\.(?:goto|reload|goBack|goForward|waitForURL|waitForNavigation|waitForLoadState)\b|navigating to/i.test(
      message,
    )
  )
    return 'navigation-timeout';
  if (/Test timeout of \d+ms exceeded/i.test(message)) return 'test-timeout';
  return 'unknown';
}

export function parseError(source: string): NormalizedError {
  const ansiEscape = new RegExp(
    `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
    'g',
  );
  const message = source
    .replace(ansiEscape, '')
    .replace(/\r\n?/g, '\n')
    .slice(0, 4096)
    .trim();
  const firstLine =
    message
      .split('\n')
      .find((line) => line.trim())
      ?.trim() ?? 'Unknown failure';
  const locatorText =
    /(?:waiting for|Locator:\s*)([^\n]+)|((?:getByRole|getByText|getByLabel|getByTestId|locator)\([^\n]+)/i.exec(
      message,
    );
  const locator = locatorText
    ? parseLocator(locatorText[1] ?? locatorText[2])
    : undefined;
  const resolved = /\b(?:locator )?resolved to\b/i.test(message);
  const expected = /^\s*Expected:\s*(.+)$/m.exec(message)?.[1]?.slice(0, 120);
  const received = /^\s*Received:\s*(.+)$/m.exec(message)?.[1]?.slice(0, 120);
  const matcher = /expect\(locator\)\.(\w+)/.exec(message)?.[1];
  const frames = [
    ...message.matchAll(
      /^\s*at (?:(?:.*? \()?)((?:[A-Za-z]:)?[^()\n]+):(\d+):\d+\)?$/gm,
    ),
  ]
    .map((frame) => ({ file: frame[1], line: Number(frame[2]) }))
    .filter(
      (frame) =>
        !/node_modules|playwright-core|internal[\\/]/i.test(frame.file),
    );
  const topFrame =
    frames.find(
      (frame) => !/\.(?:spec|test)\.[cm]?[jt]sx?$/i.test(frame.file),
    ) ?? frames[0];
  let kind: ErrorKind = 'unknown';
  if (/strict mode violation/i.test(message)) kind = 'locator-strict';
  else if (/intercepts pointer events/i.test(message))
    kind = 'action-intercepted';
  else if (/element is not attached|detached from the DOM/i.test(message))
    kind = 'locator-detached';
  else if (
    /net::ERR_|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(
      message,
    )
  )
    kind = 'navigation-network';
  else if (/Executable doesn't exist/i.test(message)) kind = 'browser-crash';
  else if (/Target page, context or browser has been closed/i.test(message))
    kind = 'target-closed';
  else if (/expected to fail, but passed/i.test(message))
    kind = 'unexpected-pass';
  else if (/beforeAll|beforeEach|afterAll|afterEach/i.test(firstLine))
    kind = 'hook-failure';
  else if (/\b(TypeError|ReferenceError|SyntaxError|RangeError):/.test(message))
    kind = 'js-error-in-test';
  else if (
    /Timed out|TimeoutError|Timeout \d+ms exceeded|timeout of \d+ms exceeded/i.test(
      firstLine,
    )
  )
    kind = timeoutKind(message, locator);
  else if (
    /element\(s\) not found/i.test(message) ||
    /received:.*not found/i.test(message)
  )
    kind = 'expect-element-missing';
  else if (expected !== undefined && received !== undefined)
    kind = matcher ? 'expect-value' : 'expect-generic';
  else if (/toBeVisible|toBeEnabled|toBeHidden|toBeDisabled/.test(message))
    kind = 'expect-element-state';
  else if (/Test timeout of \d+ms exceeded/i.test(message))
    kind = 'test-timeout';
  return {
    kind,
    message,
    firstLine,
    locator,
    matcher,
    expected,
    received,
    resolved,
    topFrame,
  };
}

function normalizeVolatile(source: string, root: string): string {
  const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source
    .replace(new RegExp(escapedRoot, 'gi'), '<project>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<id>')
    .replace(/\b\d{4}-\d\d-\d\d[T ][\d:.Z+-]+\b/g, '<ts>')
    .replace(/\b\d+ms\b/g, '#ms')
    .replace(/\b\d+\b/g, '#')
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g, '$1');
}

export function createSignature(
  error: NormalizedError,
  root: string,
  frame?: { file: string; line: number },
): string {
  const locator = error.locator?.raw ?? '';
  const location = frame
    ? `${frame.file}:${frame.line}`
    : error.topFrame
      ? `${error.topFrame.file}:${error.topFrame.line}`
      : '';
  const material = [
    error.kind,
    normalizeVolatile(error.firstLine, root),
    locator,
    error.matcher ?? '',
    location,
  ].join('|');
  return createHash('sha1').update(material).digest('hex').slice(0, 10);
}

function conditionMatches(
  condition: Record<string, unknown>,
  failure: FailureInput,
): boolean {
  for (const [key, expected] of Object.entries(condition)) {
    const actualByKey: Record<string, string> = {
      message: failure.error.message,
      firstLine: failure.error.firstLine,
      errorKind: failure.error.kind,
      matcher: failure.error.matcher ?? '',
      locator: failure.error.locator?.raw ?? '',
      file: failure.file,
      title: failure.title,
      project: failure.project,
      tags: failure.tags.join(' '),
      topFrameFile: failure.error.topFrame?.file ?? '',
    };
    const actual = actualByKey[key];
    if (actual === undefined) return false;
    if (typeof expected === 'string' && expected.startsWith('/')) {
      if (!matchPattern(expected, actual)) return false;
    } else if (Array.isArray(expected)) {
      if (!expected.includes(actual)) return false;
    } else if (typeof expected === 'string' && actual !== expected)
      return false;
    else if (typeof expected !== 'string' && !Array.isArray(expected))
      return false;
  }
  return true;
}

export interface ClassificationOptions {
  rules?: Array<{
    id: string;
    class: FailureClass;
    reason: string;
    confidence: number;
    explain: string;
    when: {
      any?: Array<Record<string, unknown>>;
      all?: Array<Record<string, unknown>>;
      not?: Array<Record<string, unknown>>;
    };
  }>;
  knownIssues?: Array<{
    id: string;
    title: string;
    link?: string;
    env?: string[];
    match: {
      pathContains?: string;
      titleContains?: string;
      errorMatches?: string;
    };
  }>;
  environment?: string;
  locatorMissingAs?: 'INCONCLUSIVE' | 'BUG';
  locatorThreshold?: number;
}

function decide(
  cls: FailureClass,
  reason: string,
  confidence: number,
  ruleId: string,
  explain: string,
): Classification {
  return {
    cls,
    reason,
    confidence: Number(confidence.toFixed(2)),
    ruleId,
    explain: explain.slice(0, 140),
  };
}

export function classifyFailure(
  failure: FailureInput,
  options: ClassificationOptions = {},
): Classification {
  if (
    failure.attempts.some(
      (attempt, index) => index > 0 && attempt.status === 'passed',
    )
  ) {
    return decide(
      'TRANSIENT',
      'transient.passed-on-rerun',
      0.95,
      'builtin.transient',
      'Passed on a failure re-run.',
    );
  }

  const known = options.knownIssues?.find((issue) => {
    const match = issue.match;
    return (
      (!issue.env || issue.env.includes(options.environment ?? '')) &&
      (!match.pathContains || failure.file.includes(match.pathContains)) &&
      (!match.titleContains ||
        failure.title
          .toLowerCase()
          .includes(match.titleContains.toLowerCase())) &&
      (!match.errorMatches ||
        matchPattern(match.errorMatches, failure.error.firstLine))
    );
  });
  if (known)
    return decide(
      'KNOWN_ISSUE',
      `known.${known.id}`,
      0.95,
      `known.${known.id}`,
      known.title,
    );

  for (const rule of options.rules ?? []) {
    const when = rule.when;
    const allMatches =
      !when.all ||
      when.all.every((condition) => conditionMatches(condition, failure));
    const anyMatches =
      !when.any ||
      when.any.some((condition) => conditionMatches(condition, failure));
    const notMatches =
      !when.not ||
      when.not.every((condition) => !conditionMatches(condition, failure));
    if (allMatches && anyMatches && notMatches) {
      return decide(
        rule.class,
        rule.reason,
        rule.confidence,
        rule.id,
        rule.explain
          .replace('{{match}}', failure.error.firstLine)
          .slice(0, 140),
      );
    }
  }

  const text = failure.error.message;
  if (
    /net::ERR_|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(
      text,
    )
  ) {
    return decide(
      'ENVIRONMENT',
      'env.network',
      0.9,
      'builtin.env.network',
      failure.error.firstLine,
    );
  }
  if (/Executable doesn't exist/i.test(text)) {
    return decide(
      'ENVIRONMENT',
      'env.browser-missing',
      0.95,
      'builtin.env.browser-missing',
      failure.error.firstLine,
    );
  }
  if (failure.error.kind === 'unexpected-pass') {
    return decide(
      'TEST_ISSUE',
      'test.unexpected-pass',
      0.9,
      'builtin.test.unexpected-pass',
      failure.error.firstLine,
    );
  }
  if (failure.error.kind === 'js-error-in-test') {
    return decide(
      'TEST_ISSUE',
      'test.code-error',
      0.8,
      'builtin.test.code-error',
      failure.error.firstLine,
    );
  }
  if (failure.error.kind === 'locator-strict') {
    const suggestion =
      failure.error.locator && failure.snapshot
        ? suggestLocator(
            failure.error.locator,
            failure.snapshot,
            options.locatorThreshold ?? 0.8,
          )
        : undefined;
    return {
      ...decide(
        'LOCATOR',
        'locator.ambiguous',
        0.9,
        'builtin.locator.ambiguous',
        failure.error.firstLine,
      ),
      ...(suggestion ? { suggestion } : {}),
    };
  }
  if (failure.error.kind === 'action-intercepted') {
    return decide(
      'ENVIRONMENT',
      'env.loading-overlay',
      0.75,
      'builtin.env.overlay',
      failure.error.firstLine,
    );
  }
  if (
    failure.error.kind.startsWith('locator-') ||
    failure.error.kind === 'expect-element-missing'
  ) {
    if (failure.error.resolved)
      return decide(
        'INCONCLUSIVE',
        'unknown',
        0.45,
        'builtin.unknown',
        failure.error.firstLine,
      );
    const suggestion =
      failure.error.locator && failure.snapshot
        ? suggestLocator(
            failure.error.locator,
            failure.snapshot,
            options.locatorThreshold ?? 0.8,
          )
        : undefined;
    if (suggestion?.unique) {
      return {
        ...decide(
          'LOCATOR',
          'locator.renamed',
          suggestion.score,
          'builtin.locator.rescan',
          `Replacement locator candidate: ${suggestion.locator}`,
        ),
        suggestion,
      };
    }
    const cls = options.locatorMissingAs ?? 'INCONCLUSIVE';
    return decide(
      cls,
      cls === 'BUG' ? 'bug.assertion-value' : 'locator.missing',
      0.45,
      'builtin.locator.missing',
      'No unique replacement locator was established.',
    );
  }
  if (
    failure.error.kind === 'expect-value' ||
    failure.error.kind === 'expect-generic'
  ) {
    return decide(
      'BUG',
      'bug.assertion-value',
      0.65,
      'builtin.bug.assertion',
      failure.error.firstLine,
    );
  }
  if (failure.error.kind === 'hook-failure') {
    return decide(
      'TEST_ISSUE',
      'test.hook-failure',
      0.55,
      'builtin.test.hook',
      failure.error.firstLine,
    );
  }
  return decide(
    'INCONCLUSIVE',
    'unknown',
    0.25,
    'builtin.unknown',
    failure.error.firstLine,
  );
}

const classPriority: Record<FailureClass, number> = {
  BUG: 0,
  LOCATOR: 1,
  TEST_ISSUE: 2,
  INCONCLUSIVE: 3,
  ENVIRONMENT: 4,
  KNOWN_ISSUE: 5,
  TRANSIENT: 6,
};

export function groupFailures(
  failures: FailureInput[],
  root: string,
  options: ClassificationOptions = {},
) {
  const classified: FailureRecord[] = failures.map((failure) => {
    const signature = failure.signature ?? createSignature(failure.error, root);
    const stable =
      failure.attempts.length < 2 ||
      new Set(
        failure.attempts
          .filter((a) => a.status === 'failed' && a.error)
          .map((a) => createSignature(parseError(a.error ?? ''), root)),
      ).size <= 1;
    let classification = classifyFailure(failure, options);
    if (!stable && classification.confidence > 0.5) {
      classification = {
        ...classification,
        confidence: 0.5,
        hints: ['signature changed between attempts'],
      };
    }
    if (!stable && classification.cls === 'LOCATOR') {
      classification = decide(
        'INCONCLUSIVE',
        'unstable.signature-changed',
        0.5,
        'builtin.unstable',
        'Failure signature changed between attempts.',
      );
    }
    return { ...failure, signature, stable, classification, groupId: '' };
  });
  const buckets = new Map<string, FailureRecord[]>();
  for (const failure of classified) {
    const key = `${failure.signature}|${failure.classification.cls}|${failure.classification.reason}`;
    buckets.set(key, [...(buckets.get(key) ?? []), failure]);
  }
  const groups = [...buckets.entries()]
    .map(([key, members]) => {
      const [signature] = key.split('|');
      members.sort(
        (a, b) =>
          a.file.localeCompare(b.file) ||
          a.line - b.line ||
          a.project.localeCompare(b.project),
      );
      const classification = members[0].classification;
      return {
        signature,
        cls: classification.cls,
        reason: classification.reason,
        confidence: Math.min(
          ...members.map((m) => m.classification.confidence),
        ),
        testIds: members.map((m) => m.id).sort(),
        representativeId: members[0].id,
        explain: classification.explain,
        suggestion: classification.suggestion,
        where: members[0].error.topFrame,
        members,
      };
    })
    .sort(
      (a, b) =>
        b.members.length - a.members.length ||
        classPriority[a.cls] - classPriority[b.cls] ||
        a.signature.localeCompare(b.signature),
    );
  groups.forEach((group, index) => {
    group.members.forEach((member) => {
      member.groupId = `G${index + 1}`;
    });
  });
  return {
    failures: classified,
    groups: groups.map(({ members: _members, ...group }, index) => ({
      id: `G${index + 1}`,
      ...group,
    })),
  };
}

export function parseAriaSnapshot(source: string): AriaNode[] {
  const roots: AriaNode[] = [];
  const stack: Array<{ indent: number; node: AriaNode }> = [];
  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    const match =
      /^(\s*)-\s+([^:[]+?)(?:\s+"([^"]*)")?(?:\s+\[([^\]]*)\])?(?::\s*(.*))?$/.exec(
        line,
      );
    if (!match) continue;
    const indent = match[1].length;
    const role = match[2].trim();
    const attrs: Record<string, string> = {};
    for (const attr of match[4]?.matchAll(/([\w-]+)=([^\s]+)/g) ?? [])
      attrs[attr[1]] = attr[2];
    const node: AriaNode = {
      role,
      name: match[3] ?? '',
      attrs,
      value: match[5]?.trim(),
      children: [],
      path: [],
    };
    while (stack.length && stack[stack.length - 1].indent >= indent)
      stack.pop();
    if (stack.length) stack[stack.length - 1].node.children.push(node);
    else roots.push(node);
    stack.push({ indent, node });
  }
  const assignPath = (nodes: AriaNode[], ancestors: string[]) => {
    for (const node of nodes) {
      node.path = [
        ...ancestors,
        [node.role, node.name].filter(Boolean).join(':'),
      ];
      assignPath(node.children, node.path);
    }
  };
  assignPath(roots, []);
  return roots;
}

function flattenAria(nodes: AriaNode[]): AriaNode[] {
  return nodes.flatMap((node) => [node, ...flattenAria(node.children)]);
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s*.,:;!?]+$/g, '')
    .trim();
}

function tokenSimilarity(a: string, b: string): number {
  const left = new Set(normalizeText(a).split(' ').filter(Boolean));
  const right = new Set(normalizeText(b).split(' ').filter(Boolean));
  if (!left.size && !right.size) return 1;
  const intersection = [...left].filter((word) => right.has(word)).length;
  return (2 * intersection) / (left.size + right.size);
}

function jaroWinkler(left: string, right: string): number {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const distance = Math.max(
    0,
    Math.floor(Math.max(a.length, b.length) / 2) - 1,
  );
  const aMatches = new Array<boolean>(a.length).fill(false);
  const bMatches = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    const start = Math.max(0, i - distance);
    const end = Math.min(i + distance + 1, b.length);
    for (let j = start; j < end; j += 1) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches += 1;
      break;
    }
  }
  if (!matches) return 0;
  let transpositions = 0;
  for (let i = 0, j = 0; i < a.length; i += 1) {
    if (!aMatches[i]) continue;
    while (!bMatches[j]) j += 1;
    if (a[i] !== b[j]) transpositions += 1;
    j += 1;
  }
  const jaro =
    (matches / a.length +
      matches / b.length +
      (matches - transpositions / 2) / matches) /
    3;
  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix])
    prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

export function suggestLocator(
  locator: ParsedLocator,
  snapshot: AriaNode[],
  threshold = 0.8,
): LocatorSuggestion | undefined {
  const nodes = flattenAria(snapshot);
  const candidates = nodes
    .map((node) => {
      let candidate: string;
      let score: number;
      if (locator.kind === 'role' && locator.role) {
        if (node.role !== locator.role) return undefined;
        const similarity = Math.max(
          tokenSimilarity(locator.name ?? '', node.name),
          jaroWinkler(locator.name ?? '', node.name),
        );
        score = 0.35 + 0.5 * similarity + 0.15 * 0.5;
        candidate = `getByRole('${node.role}', { name: ${JSON.stringify(node.name)}, exact: true })`;
      } else {
        const similarity = tokenSimilarity(
          locator.name ?? '',
          node.name || node.value || '',
        );
        if (!similarity) return undefined;
        score = similarity;
        candidate = `getByRole('${node.role}', { name: ${JSON.stringify(node.name)}, exact: true })`;
      }
      return {
        locator: candidate,
        score: Number(score.toFixed(2)),
        unique:
          nodes.filter(
            (other) => other.role === node.role && other.name === node.name,
          ).length === 1,
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> =>
      Boolean(candidate),
    )
    .sort((a, b) => b.score - a.score || a.locator.localeCompare(b.locator))
    .slice(0, 3);
  const best = candidates[0];
  if (!best || best.score < threshold) return undefined;
  return { ...best, candidates };
}

export function estimateTokens(source: string): number {
  return Math.ceil(source.length / 4);
}

export function truncateToTokens(source: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (source.length <= maxChars) return source;
  const marker = '\n[truncated]';
  return `${source.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}

function nameMatcher(namePattern: string): RegExp {
  return new RegExp(namePattern.replace(/^\(\?i\)/, ''), 'i');
}

export function isSecretName(
  name: string,
  namePattern = DEFAULT_SECRET_NAME_PATTERN,
): boolean {
  return nameMatcher(namePattern).test(name);
}

export function secretValues(
  env: Record<string, string>,
  namePattern = DEFAULT_SECRET_NAME_PATTERN,
): string[] {
  const matcher = nameMatcher(namePattern);
  return Object.entries(env)
    .filter(
      ([name, value]) =>
        value.length >= MIN_SECRET_LENGTH && matcher.test(name),
    )
    .map(([, value]) => value);
}

// A header value runs to the end of its line, or is one quoted string when the
// header is printed as JSON or as an object literal.
const SENSITIVE_HEADER =
  /\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key)(["']?[ \t]*[:=][ \t]*)("(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|[^\r\n]+)/gi;

// Matches `password=abc`, `"token": "abc"` and `DB_SECRET: abc` on one line.
// The bounded suffix keeps matching linear on long inputs, and the lookahead
// keeps repeated redaction passes idempotent.
const SECRET_PAIR =
  /((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[\w.-]{0,40}["']?[ \t]*[:=][ \t]*)("[^"\r\n]*"|'[^'\r\n]*'|(?!\[REDACTED\]|\\)[^\s,;&"'}\]]+)/gi;

const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/?#]+:)[^\s@/?#]+(@)/gi;

const JSON_WEB_TOKEN = /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g;

function keepQuote(prefix: string, value: string): string {
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
  return `${prefix}${quote}[REDACTED]${quote}`;
}

export function redactText(
  source: string,
  secretValues: string[] = [],
): string {
  let result = source
    .replace(
      SENSITIVE_HEADER,
      (_match, name: string, separator: string, value: string) =>
        keepQuote(`${name}${separator}`, value),
    )
    .replace(SECRET_PAIR, (_match, key: string, value: string) =>
      keepQuote(key, value),
    )
    .replace(URL_PASSWORD, '$1[REDACTED]$2')
    .replace(JSON_WEB_TOKEN, '[REDACTED]')
    .replace(
      /([?&](?:token|key|password|secret|session|cpf|cnpj)=)[^&\s]*/gi,
      '$1[REDACTED]',
    );
  const longestFirst = [...new Set(secretValues)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const secret of longestFirst)
    result = result.split(secret).join('[REDACTED]');
  return result;
}

export function renderSummary(input: {
  runId: string;
  status: string;
  duration: string;
  tags: string[];
  match: 'any' | 'all';
  projects: string[];
  playwright: string;
  runtime: string;
  selected: number;
  passed: number;
  failed: number;
  skipped: number;
  groups: Group[];
  failures: FailureRecord[];
  maxGroups?: number;
  maxTokens?: number;
}): string {
  const lines = [
    `run ${input.runId} ${input.status} ${input.duration} | tags ${input.match}(${input.tags.join(',')}) | proj ${input.projects.join(',') || 'all'} | pw ${input.playwright} ${input.runtime}`,
    `tests ${input.selected} | passed ${input.passed} | failed ${input.failed} | groups ${input.groups.length} | skipped ${input.skipped}`,
  ];
  for (const group of input.groups.slice(0, input.maxGroups ?? 15)) {
    const representative = input.failures.find(
      (failure) => failure.id === group.representativeId,
    );
    const where = representative
      ? `${representative.file}:${representative.line}`
      : '';
    lines.push(
      `${group.id} ${group.cls} ${group.testIds.length} c${group.confidence.toFixed(2)} ${group.reason} ${where}`.trimEnd(),
    );
    lines.push(`  ${group.explain.slice(0, 160)}`);
    if (group.suggestion)
      lines.push(
        `  suggest: ${group.suggestion.locator} (unique=${group.suggestion.unique}, score=${group.suggestion.score.toFixed(2)})`,
      );
  }
  if (input.groups.length > (input.maxGroups ?? 15))
    lines.push(
      `[+${input.groups.length - (input.maxGroups ?? 15)} more groups]`,
    );
  lines.push(`files: .test-container/runs/${input.runId}/`);
  return truncateToTokens(lines.join('\n'), input.maxTokens ?? 1500);
}
