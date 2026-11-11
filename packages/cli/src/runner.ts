import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import {
  type FailureInput,
  groupFailures,
  parseAriaSnapshot,
  parseError,
  parseKnownIssues,
  parseRules,
  redactText,
  renderSummary,
  secretValues,
} from '@scope/core';
import {
  buildRunArgs,
  CONTAINER_BUN,
  CONTAINER_ROOT,
  CONTAINER_TOOL_DIR,
  type DockerSettings,
  fromContainerPath,
  getInstallPlan,
  installScript,
  resolveImage,
  toContainerPath,
} from './docker.js';
import { writeJsonAtomic, writeTextAtomic } from './files.js';
import { javascriptArgs } from './runtime.js';

type ContainerContext = {
  settings: DockerSettings;
  image: string;
  toolDir: string;
};

type TestRef = {
  id: string;
  titlePath: string[];
  file: string;
  line: number;
  project: string;
  tags: string[];
  expectedStatus: string;
};

type EventFile = {
  selected: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: Array<{
    test: TestRef;
    errors: Array<{ message: string; stack?: string }>;
    status: string;
    attachments?: Array<{ name: string; path: string }>;
  }>;
  rerunPassed: TestRef[];
};

type RunRequest = {
  tags: string[];
  match: 'any' | 'all';
  grep?: string;
  grepInvert?: string;
  projects: string[];
  workers: number;
  rerunAttempts: number;
  runtime: 'native' | 'docker';
  projectRoot: string;
  workdir: string;
  onlyTests?: Array<{ file: string; line: number; project: string }>;
  envNames: string[];
};

type RunState = {
  id: string;
  status: 'starting' | 'running' | 'done' | 'error' | 'cancelled';
  phase: string;
  request: RunRequest;
  runtime: { mode: string; image?: string; container?: string; pid?: number };
  versions: {
    playwright: string;
    testContainer: string;
    node: string;
    bun?: string;
  };
  counters: {
    selected: number;
    done: number;
    passed: number;
    failed: number;
    skipped: number;
    afterRerun?: number;
    groups?: number;
  };
  startedAt: string;
  endedAt?: string;
  error?: { code: string; message: string; fix: string; tail?: string[] };
};

const LOG_LIMIT = 2 * 1024 * 1024;
const TAG_BOUNDARY = '(?![\\w-])';

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function composeTagGrep(
  tags: string[],
  match: 'any' | 'all',
  grep?: string,
): string | undefined {
  const normalized = tags.map((tag) => (tag.startsWith('@') ? tag : `@${tag}`));
  const tagPart =
    normalized.length === 0
      ? undefined
      : match === 'any'
        ? `(?:${normalized.map((tag) => `${escapeRegex(tag)}${TAG_BOUNDARY}`).join('|')})`
        : `^${normalized.map((tag) => `(?=.*${escapeRegex(tag)}${TAG_BOUNDARY})`).join('')}`;
  if (!tagPart) return grep;
  return grep ? `(?=${tagPart})(?=${grep})` : tagPart;
}

export function composeTagInvert(
  grepInvert: string | undefined,
  noRunTags: string[],
): string | undefined {
  const excluded = noRunTags.map((tag) => {
    const normalized = tag.startsWith('@') ? tag : `@${tag}`;
    return `${escapeRegex(normalized)}${TAG_BOUNDARY}`;
  });
  if (grepInvert) excluded.push(`(?:${grepInvert})`);
  return excluded.length ? `(?:${excluded.join('|')})` : undefined;
}

// Playwright reads each positional argument as a case-insensitive regular
// expression and, on Windows, also tries it against the forward-slash form of
// the path, so escaping that form makes the path match literally.
export function composeLocation(path: string, line: number): string {
  return `${escapeRegex(path.replaceAll('\\', '/'))}:${line}`;
}

function getPlaywrightCli(projectRoot: string): {
  cli: string;
  version: string;
} {
  const require = createRequire(join(projectRoot, 'package.json'));
  let packagePath: string;
  try {
    packagePath = require.resolve('@playwright/test/package.json');
  } catch {
    try {
      packagePath = require.resolve('playwright/package.json');
    } catch {
      throw new Error(
        'TC_E_PW_NOT_FOUND: @playwright/test is not installed in the selected project.',
      );
    }
  }
  const packageJson = readJson<{ version: string }>(packagePath);
  const cli = require.resolve('@playwright/test/cli', { paths: [projectRoot] });
  return { cli, version: packageJson.version };
}

function appendCapped(current: Buffer, chunk: Buffer): Buffer {
  if (current.length + chunk.length <= LOG_LIMIT)
    return Buffer.concat([current, chunk]);
  const headSize = Math.floor(LOG_LIMIT / 2);
  const tailSize = LOG_LIMIT - headSize;
  if (current.length < headSize) {
    const head = Buffer.concat([current, chunk]).subarray(0, headSize);
    return Buffer.concat([
      head,
      chunk.subarray(Math.max(0, chunk.length - tailSize)),
    ]);
  }
  return Buffer.concat([
    current.subarray(0, headSize),
    Buffer.concat([current.subarray(headSize), chunk]).subarray(-tailSize),
  ]);
}

function spawnProcess(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; output: Buffer }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
    });
    let output: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    child.stdout.on('data', (chunk: Buffer) => {
      output = appendCapped(output, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output = appendCapped(output, chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => resolvePromise({ code: code ?? 1, output }));
  });
}

function getRunArgs(
  state: RunState,
  reporterPath: string,
  grep: string | undefined,
  grepInvert: string | undefined,
  workers: number,
  list = false,
  mapPath: (path: string) => string = (path) => path,
): string[] {
  const args: string[] = [];
  const config = process.env.TC_PLAYWRIGHT_CONFIG;
  if (config) args.push('--config', mapPath(config));
  if (grep) args.push('--grep', grep);
  if (grepInvert) args.push('--grep-invert', grepInvert);
  for (const project of state.request.projects) args.push('--project', project);
  args.push(
    '--workers',
    String(workers),
    '--retries=0',
    '--output',
    mapPath(join(process.env.TC_RUN_DIR ?? '', 'pw-output')),
  );
  args.push('--reporter', reporterPath, '--trace=retain-on-failure');
  for (const test of state.request.onlyTests ?? []) {
    args.push(
      composeLocation(
        mapPath(resolve(state.request.projectRoot, test.file)),
        test.line,
      ),
    );
  }
  if (list) args.push('--list');
  const extraArgs = (
    JSON.parse(process.env.TC_EXTRA_ARGS ?? '[]') as string[]
  ).filter(Boolean);
  const deny = new Set(['--output', '--reporter', '--retries']);
  for (const arg of extraArgs) {
    if (
      [...deny].some(
        (blocked) => arg === blocked || arg.startsWith(`${blocked}=`),
      )
    ) {
      throw new Error(
        `TC_E_CONFIG_INVALID: playwright.extraArgs cannot override ${arg}.`,
      );
    }
  }
  args.push(...extraArgs);
  return args;
}

async function runPhase(
  state: RunState,
  cli: string,
  eventsPath: string,
  mode: string,
  grep: string | undefined,
  grepInvert: string | undefined,
  workers: number,
  lastFailed = false,
  rerunIds: string[] = [],
  container?: ContainerContext,
): Promise<{ events: EventFile; exitCode: number; output: Buffer }> {
  const runDir = process.env.TC_RUN_DIR ?? '';
  const root = state.request.projectRoot;
  const mapPath = container
    ? (path: string) => toContainerPath(path, root)
    : (path: string) => path;
  const reporterPath = container
    ? `${CONTAINER_TOOL_DIR}/reporter.cjs`
    : join(dirname(__filename), 'reporter.cjs');
  const args = getRunArgs(
    state,
    reporterPath,
    grep,
    grepInvert,
    workers,
    mode === 'list',
    mapPath,
  );
  if (lastFailed) args.push('--last-failed');
  const phaseEnv: Record<string, string> = {
    ...forwardedEnv(state.request.envNames),
    TC_RUN_DIR: mapPath(runDir),
    TC_EVENTS_FILE: mapPath(eventsPath),
    TC_MODE: mode,
    TC_RERUN_IDS: rerunIds.join(','),
  };
  const { code, output } = container
    ? await spawnProcess(
        container.settings.engine,
        buildRunArgs({
          settings: container.settings,
          image: container.image,
          root,
          toolDir: container.toolDir,
          workdir: state.request.workdir,
          runId: state.id,
          name: `tc-${state.id}-${mode}-${Date.now().toString(36)}`,
          envNames: Object.keys(phaseEnv),
          command: [
            ...(process.versions.bun
              ? [CONTAINER_BUN, ...javascriptArgs([])]
              : []),
            `${CONTAINER_ROOT}/node_modules/.bin/playwright`,
            'test',
            ...args,
          ],
          owner: hostOwner(),
        }),
        root,
        { ...process.env, ...phaseEnv },
      )
    : await spawnProcess(
        process.execPath,
        javascriptArgs([cli, 'test', ...args]),
        state.request.workdir,
        { ...process.env, ...phaseEnv },
      );
  if (!existsSync(eventsPath))
    throw new Error(
      `TC_E_PLAYWRIGHT_CRASH: Playwright exited without reporter output (exit ${code}). ${scrubLog(output, runSecrets(state)).slice(-5).join(' | ')}`,
    );
  const events = readJson<EventFile>(eventsPath);
  return {
    events: container ? mapEventPaths(events, root) : events,
    exitCode: code,
    output,
  };
}

// run.json stores only variable names. The values reach this process through
// its own environment, set when the service started it.
export function forwardedEnv(
  names: readonly string[],
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function runSecrets(state: RunState): string[] {
  const config = JSON.parse(process.env.TC_CONFIG ?? '{}') as {
    redaction?: { namePattern?: string };
  };
  return secretValues(
    forwardedEnv(state.request.envNames),
    config.redaction?.namePattern,
  );
}

function hostOwner(): { uid: number; gid: number } | undefined {
  if (process.platform !== 'linux' || !process.getuid || !process.getgid)
    return undefined;
  return { uid: process.getuid(), gid: process.getgid() };
}

export function mapEventPaths(events: EventFile, root: string): EventFile {
  const mapTest = (test: TestRef): TestRef => ({
    ...test,
    file: fromContainerPath(test.file, root),
  });
  return {
    ...events,
    failures: events.failures.map((failure) => ({
      ...failure,
      test: mapTest(failure.test),
      attachments: failure.attachments?.map((attachment) => ({
        ...attachment,
        path: fromContainerPath(attachment.path, root),
      })),
    })),
    rerunPassed: events.rerunPassed.map(mapTest),
  };
}

async function prepareContainer(
  state: RunState,
  runDir: string,
  playwrightVersion: string,
  settings: DockerSettings,
): Promise<ContainerContext> {
  const root = state.request.projectRoot;
  const image = resolveImage(settings.image, playwrightVersion);
  const toolDir = dirname(__filename);
  const env = process.env;
  const log: string[] = [];
  const run = async (args: string[]) => {
    const result = await spawnProcess(settings.engine, args, root, env);
    log.push(
      `$ ${settings.engine} ${args.join(' ')}`,
      result.output.toString('utf8'),
    );
    return result;
  };
  try {
    const present = (await run(['image', 'inspect', image])).code === 0;
    if (
      settings.pull === 'always' ||
      (!present && settings.pull === 'if-missing')
    ) {
      const pulled = await run(['pull', image]);
      if (pulled.code !== 0)
        throw new Error(
          `TC_E_ENGINE_UNAVAILABLE: could not pull ${image}. ${scrubLog(pulled.output, []).slice(-3).join(' | ')}`,
        );
    } else if (!present) {
      throw new Error(
        `TC_E_ENGINE_UNAVAILABLE: image ${image} is missing and docker.pull is "never".`,
      );
    }
    const plan = getInstallPlan(root, image);
    const installed = await run(
      buildRunArgs({
        settings,
        image,
        root,
        toolDir,
        workdir: root,
        runId: state.id,
        name: `tc-${state.id}-install`,
        envNames: [],
        command: ['sh', '-c', installScript(plan, process.versions.bun)],
        owner: hostOwner(),
      }),
    );
    if (installed.code !== 0)
      throw new Error(
        `TC_E_DEPS_INSTALL: dependency install failed in the container (${plan.lockfile ?? 'package.json'}). ${scrubLog(installed.output, []).slice(-5).join(' | ')}`,
      );
    return { settings, image, toolDir };
  } finally {
    writeFileSync(
      join(runDir, 'logs', 'container.prepare.log'),
      scrubLog(Buffer.from(log.join('\n')), runSecrets(state)).join('\n'),
    );
  }
}

function updateState(runDir: string, state: RunState): void {
  writeJsonAtomic(join(runDir, 'run.json'), state);
}

function projectRelative(path: string, root: string): string {
  const rel = relative(root, path);
  return rel && !rel.startsWith('..')
    ? rel.replaceAll('\\', '/')
    : basename(path);
}

function toFailures(
  events: EventFile,
  root: string,
  attempts?: Map<
    string,
    Array<{ status: 'passed' | 'failed' | 'skipped'; error?: string }>
  >,
  secrets: string[] = [],
  runDir = '',
): FailureInput[] {
  return events.failures.map((entry) => {
    const raw = entry.errors[0];
    const primary = redactText(
      [raw?.message ?? 'Unknown Playwright failure', raw?.stack]
        .filter(Boolean)
        .join('\n'),
      secrets,
    );
    const attemptList = (attempts?.get(entry.test.id) ?? []).map((attempt) =>
      attempt.error === undefined
        ? attempt
        : { ...attempt, error: redactText(attempt.error, secrets) },
    );
    const attachments = entry.attachments ?? [];
    const errorContext = attachments.find((attachment) =>
      /error-context\.md$/i.test(attachment.name || attachment.path),
    );
    const snapshot =
      errorContext && existsSync(errorContext.path)
        ? readAriaSnapshot(errorContext.path, secrets)
        : undefined;
    return {
      id: entry.test.id,
      file: projectRelative(entry.test.file, root),
      line: entry.test.line,
      project: entry.test.project,
      title: entry.test.titlePath.join(' › '),
      tags: entry.test.tags,
      attempts: attemptList.length
        ? attemptList
        : [
            {
              status: entry.status === 'timedOut' ? 'timedOut' : 'failed',
              error: primary,
            },
          ],
      error: parseError(primary),
      snapshot,
      artifacts: attachments.map((attachment) =>
        relative(runDir, attachment.path).replaceAll('\\', '/'),
      ),
    };
  });
}

function readAriaSnapshot(
  path: string,
  secrets: string[],
): ReturnType<typeof parseAriaSnapshot> {
  const content = redactText(readFileSync(path, 'utf8'), secrets);
  const match = /(?:Page snapshot:|#+\s*Page snapshot)\s*\n([\s\S]*)/i.exec(
    content,
  );
  const snapshot = match?.[1] ?? content;
  const trimmed = snapshot.split(/\n(?:Call log:|Error Context:|#\s)/i)[0];
  return parseAriaSnapshot(trimmed);
}

// Redact decoded string values, not the serialized text, so the file stays
// valid JSON and escaped content is matched like any other text.
function redactJson(content: string, secrets: string[]): string {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return redactText(value, secrets);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, walk(item)]),
      );
    return value;
  };
  try {
    const parsed: unknown = JSON.parse(content);
    const redacted = walk(parsed);
    return JSON.stringify(redacted) === JSON.stringify(parsed)
      ? content
      : JSON.stringify(redacted, null, 2);
  } catch {
    return redactText(content, secrets);
  }
}

export function redactRunArtifacts(root: string, secrets: string[]): void {
  const textExtensions = new Set(['.json', '.md', '.html', '.log', '.txt']);
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (textExtensions.has(extname(path).toLowerCase())) {
        const content = readFileSync(path, 'utf8');
        const redacted =
          extname(path).toLowerCase() === '.json'
            ? redactJson(content, secrets)
            : redactText(content, secrets);
        if (redacted !== content) writeTextAtomic(path, redacted);
      }
    }
  };
  visit(root);
}

function scrubLog(output: Buffer | string, secrets: string[]): string[] {
  const ansiEscape = new RegExp(
    `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
    'g',
  );
  const text = output.toString('utf8').replace(ansiEscape, '');
  const rows = text.split(/\r?\n/).filter(Boolean);
  return rows.slice(-20).map((line) => redactText(line, secrets).slice(0, 500));
}

export function outputTail(output: Buffer | string, secrets: string[]): string {
  return scrubLog(output, secrets).slice(-8).join(' | ');
}

async function delay(seconds: number): Promise<void> {
  await new Promise((resolvePromise) =>
    setTimeout(resolvePromise, seconds * 1000),
  );
}

async function pipeline(runDir: string): Promise<void> {
  const statePath = join(runDir, 'run.json');
  const state = readJson<RunState>(statePath);
  const secrets = runSecrets(state);
  state.status = 'running';
  state.phase = 'preflight';
  updateState(runDir, state);
  const { cli, version } = getPlaywrightCli(state.request.workdir);
  state.versions.playwright = version;
  state.versions.node = process.version;
  state.versions.bun = process.versions.bun;
  const configPath = process.env.TC_PLAYWRIGHT_CONFIG;
  if (configPath && !isAbsolute(configPath))
    process.env.TC_PLAYWRIGHT_CONFIG = resolve(
      state.request.workdir,
      configPath,
    );

  const tags = state.request.tags;
  const grep = composeTagGrep(tags, state.request.match, state.request.grep);
  const grepInvert = composeTagInvert(
    state.request.grepInvert,
    JSON.parse(process.env.TC_NO_RUN_TAGS ?? '[]') as string[],
  );
  state.phase = 'selection';
  updateState(runDir, state);
  const selectionPath = join(runDir, 'selection.json');
  const selection = await runPhase(
    state,
    cli,
    selectionPath,
    'list',
    grep,
    grepInvert,
    state.request.workers,
  );
  if (selection.exitCode !== 0)
    throw new Error(
      `TC_E_PLAYWRIGHT_CRASH: Playwright selection failed. ${outputTail(selection.output, secrets)}`,
    );
  if (selection.events.selected === 0)
    throw new Error(
      `TC_E_NO_TESTS: no tests selected for grep ${grep ?? '(none)'}.`,
    );
  state.counters.selected = selection.events.selected;
  writeFileSync(
    join(runDir, 'selection.json'),
    JSON.stringify({ count: selection.events.selected }),
  );

  state.phase = 'execute';
  updateState(runDir, state);
  let container: ContainerContext | undefined;
  if (state.request.runtime === 'docker') {
    state.phase = 'prepare';
    updateState(runDir, state);
    const dockerConfig = (
      JSON.parse(process.env.TC_CONFIG ?? '{}') as {
        docker?: Partial<DockerSettings>;
      }
    ).docker;
    container = await prepareContainer(state, runDir, version, {
      engine: dockerConfig?.engine ?? 'docker',
      image: dockerConfig?.image ?? 'auto',
      pull: dockerConfig?.pull ?? 'if-missing',
      extraArgs: dockerConfig?.extraArgs ?? ['--ipc=host'],
      hostGateway: dockerConfig?.hostGateway ?? true,
    });
    state.runtime.image = container.image;
    state.phase = 'execute';
    updateState(runDir, state);
  }
  const firstPath = join(runDir, 'events.phase1.json');
  const phase1 = await runPhase(
    state,
    cli,
    firstPath,
    'run',
    grep,
    grepInvert,
    state.request.workers,
    false,
    [],
    container,
  );
  writeFileSync(
    join(runDir, 'logs', 'playwright.phase1.log'),
    scrubLog(phase1.output, secrets).join('\n'),
  );
  if (phase1.exitCode !== 0 && phase1.exitCode !== 1) {
    throw new Error(
      `TC_E_PLAYWRIGHT_CRASH: Playwright exited with ${phase1.exitCode}. ${outputTail(phase1.output, secrets)}`,
    );
  }
  // Exit code 1 means failed tests. With none reported, the run itself failed,
  // for example in global setup or on a global timeout.
  if (phase1.exitCode !== 0 && phase1.events.failures.length === 0) {
    throw new Error(
      `TC_E_PLAYWRIGHT_CRASH: Playwright exited with ${phase1.exitCode} but reported no failed tests. ${outputTail(phase1.output, secrets)}`,
    );
  }
  let activeFailures = phase1.events.failures;
  const attempts = new Map<
    string,
    Array<{ status: 'passed' | 'failed' | 'skipped'; error?: string }>
  >();
  for (const failure of activeFailures)
    attempts.set(failure.test.id, [
      { status: 'failed', error: failure.errors[0]?.message },
    ]);
  let lastOutput = phase1.output;
  let passedOnRerun = 0;
  const maxAttempts = state.request.rerunAttempts;
  const backoffs = JSON.parse(
    process.env.TC_BACKOFF_SECONDS ?? '[10,30]',
  ) as number[];
  const noRerunTags = JSON.parse(
    process.env.TC_RERUN_NO_TAGS ?? '["@no-rerun"]',
  ) as string[];
  const rerunnable = () =>
    activeFailures.filter(
      (failure) => !failure.test.tags.some((tag) => noRerunTags.includes(tag)),
    );
  for (const failure of activeFailures) {
    const excludedTag = failure.test.tags.find((tag) =>
      noRerunTags.includes(tag),
    );
    if (excludedTag) {
      attempts.get(failure.test.id)?.push({
        status: 'skipped',
        error: `Rerun skipped by tag ${excludedTag}.`,
      });
    } else if (maxAttempts === 0) {
      attempts.get(failure.test.id)?.push({
        status: 'skipped',
        error: 'Reruns are disabled for this run.',
      });
    }
  }
  for (
    let attempt = 1;
    attempt <= maxAttempts && rerunnable().length > 0;
    attempt += 1
  ) {
    const current = rerunnable();
    const wait = backoffs[attempt - 1] ?? 0;
    if (wait) await delay(wait);
    state.phase = `rerun-${attempt}`;
    updateState(runDir, state);
    const rerunPath = join(runDir, `events.phase2-attempt${attempt}.json`);
    const rerun = await runPhase(
      state,
      cli,
      rerunPath,
      'rerun',
      undefined,
      composeTagInvert(undefined, noRerunTags),
      Number(process.env.TC_RERUN_WORKERS ?? 1),
      true,
      current.map((failure) => failure.test.id),
      container,
    );
    writeFileSync(
      join(runDir, 'logs', `playwright.phase2.attempt${attempt}.log`),
      scrubLog(rerun.output, secrets).join('\n'),
    );
    if (rerun.exitCode !== 0 && rerun.exitCode !== 1)
      throw new Error(
        `TC_E_PLAYWRIGHT_CRASH: re-run exited with ${rerun.exitCode}.`,
      );
    const passedIds = new Set(rerun.events.rerunPassed.map((test) => test.id));
    const failedById = new Map(
      rerun.events.failures.map((failure) => [failure.test.id, failure]),
    );
    const next: typeof activeFailures = [];
    for (const failure of current) {
      const history = attempts.get(failure.test.id) ?? [];
      const latest = failedById.get(failure.test.id);
      if (passedIds.has(failure.test.id)) {
        history.push({ status: 'passed' });
        attempts.set(failure.test.id, history);
        passedOnRerun += 1;
      } else if (latest) {
        history.push({ status: 'failed', error: latest.errors[0]?.message });
        attempts.set(failure.test.id, history);
        next.push(latest);
      } else {
        next.push(failure);
      }
    }
    activeFailures = [
      ...activeFailures.filter(
        (failure) => !current.some((item) => item.test.id === failure.test.id),
      ),
      ...next,
    ];
    lastOutput = rerun.output;
  }

  state.phase = 'collect';
  const pendingById = new Map(
    activeFailures.map((failure) => [failure.test.id, failure]),
  );
  const allFinal = [
    ...phase1.events.failures.filter(
      (failure) => !pendingById.has(failure.test.id),
    ),
    ...activeFailures,
  ];
  const config = JSON.parse(process.env.TC_CONFIG ?? '{}') as {
    classification?: {
      envVar?: string;
      rules?: string;
      knownIssues?: string;
      locatorMissingAs?: 'INCONCLUSIVE' | 'BUG';
      locatorThreshold?: number;
    };
    report?: { maxSummaryTokens?: number; maxGroupsInSummary?: number };
  };
  const failures = toFailures(
    { ...phase1.events, failures: allFinal },
    state.request.projectRoot,
    attempts,
    secrets,
    runDir,
  );
  const knownFile = join(
    state.request.projectRoot,
    config.classification?.knownIssues ?? 'test-container.known-issues.yml',
  );
  const rulesFile = join(
    state.request.projectRoot,
    config.classification?.rules ?? 'test-container.rules.yml',
  );
  const knownIssues = existsSync(knownFile)
    ? parseKnownIssues(readFileSync(knownFile, 'utf8'))
    : [];
  const rules = existsSync(rulesFile)
    ? parseRules(readFileSync(rulesFile, 'utf8'))
    : [];
  const grouped = groupFailures(failures, state.request.projectRoot, {
    knownIssues,
    rules,
    environment: process.env[config.classification?.envVar ?? 'ENV'],
    locatorMissingAs: config.classification?.locatorMissingAs,
    locatorThreshold: config.classification?.locatorThreshold,
  });
  state.phase = 'report';
  state.counters.passed = phase1.events.passed + passedOnRerun;
  state.counters.failed = activeFailures.length;
  state.counters.afterRerun = activeFailures.length;
  state.counters.skipped = phase1.events.skipped;
  state.counters.done = state.counters.selected;
  state.counters.groups = grouped.groups.length;
  const failuresJson = {
    schemaVersion: 1,
    run: { id: state.id, status: 'done', selected: state.counters.selected },
    groups: grouped.groups,
    failures: grouped.failures.map(
      ({ snapshot: _snapshot, ...failure }) => failure,
    ),
  };
  writeFileSync(
    join(runDir, 'failures.json'),
    JSON.stringify(failuresJson, null, 2),
  );
  mkdirSync(join(runDir, 'groups'), { recursive: true });
  mkdirSync(join(runDir, 'failures'), { recursive: true });
  for (const group of grouped.groups) {
    const members = grouped.failures.filter(
      (failure) => failure.groupId === group.id,
    );
    const memberLines = members
      .slice(0, 20)
      .map(
        (failure) =>
          `${failure.id} ${failure.file}:${failure.line} ${failure.title.slice(0, 80)} [${failure.project}]`,
      );
    const skippedReruns = members.flatMap((failure) =>
      failure.attempts
        .filter((attempt) => attempt.status === 'skipped' && attempt.error)
        .map((attempt) => `${failure.id}: ${attempt.error}`),
    );
    const report = [
      `${group.id} ${group.cls} ${group.reason} c${group.confidence.toFixed(2)} ${group.signature}`,
      `tests: ${memberLines.join('\n')}${members.length > 20 ? `\n+${members.length - 20} more` : ''}`,
      `error: ${members[0]?.error.firstLine ?? ''}`,
      ...(skippedReruns.length ? [`rerun: ${skippedReruns.join('; ')}`] : []),
      ...(group.suggestion
        ? [
            `suggest: ${group.suggestion.locator} unique=${group.suggestion.unique} score=${group.suggestion.score.toFixed(2)}`,
          ]
        : []),
      `next: ${group.cls === 'BUG' ? 'report the evidence; do not change the test to hide the failure' : group.cls === 'LOCATOR' ? 'inspect and update the locator' : 'review the evidence before changing tests'}`,
    ].join('\n\n');
    writeFileSync(join(runDir, 'groups', `${group.id}.md`), report);
  }
  const elapsedMs = Date.now() - Date.parse(state.startedAt);
  const summary = renderSummary({
    runId: state.id,
    status: 'done',
    duration: `${Math.round(elapsedMs / 60000)}m`,
    tags: state.request.tags,
    match: state.request.match,
    projects: state.request.projects,
    playwright: version,
    runtime: state.runtime.mode,
    selected: state.counters.selected,
    passed: state.counters.passed,
    failed: state.counters.failed,
    skipped: state.counters.skipped,
    groups: grouped.groups,
    failures: grouped.failures,
    maxGroups: config.report?.maxGroupsInSummary,
    maxTokens: config.report?.maxSummaryTokens,
  });
  writeFileSync(join(runDir, 'summary.md'), summary);
  writeFileSync(
    join(runDir, 'logs', 'runner.log'),
    `run ${state.id} done in ${elapsedMs}ms\n${scrubLog(lastOutput, secrets).join('\n')}`,
  );
  redactRunArtifacts(runDir, secrets);
  state.status = 'done';
  state.phase = 'done';
  state.endedAt = new Date().toISOString();
  updateState(runDir, state);
}

async function main(): Promise<void> {
  const runArg = process.argv[process.argv.indexOf('--run-dir') + 1];
  if (!runArg || runArg.startsWith('--'))
    throw new Error('Usage: runner.cjs pipeline --run-dir <path>');
  const runDir = resolve(runArg);
  const statePath = join(runDir, 'run.json');
  mkdirSync(join(runDir, 'logs'), { recursive: true });
  try {
    await pipeline(runDir);
  } catch (error) {
    const state = readJson<RunState>(statePath);
    const secrets = runSecrets(state);
    const message = redactText(
      error instanceof Error ? error.message : String(error),
      secrets,
    );
    const coded = /^(TC_E_[A-Z_]+): ([\s\S]*)$/.exec(message);
    state.status = 'error';
    state.phase = 'error';
    state.endedAt = new Date().toISOString();
    state.error = {
      code: coded?.[1] ?? 'TC_E_RUNNER_FAILED',
      message: coded?.[2] ?? message,
      fix: 'Check the Playwright project, configuration, selected tags, and the logs in the run folder.',
    };
    try {
      redactRunArtifacts(runDir, secrets);
    } catch {
      process.stderr.write('Failed to redact the run artifacts.\n');
    }
    updateState(runDir, state);
  } finally {
    try {
      const state = readJson<RunState>(statePath);
      const projectStore = join(state.request.projectRoot, '.test-container');
      const lockPath = join(projectStore, 'lock');
      if (existsSync(lockPath)) {
        const lock = readJson<{ run_id: string }>(lockPath);
        if (lock.run_id === state.id) {
          const { unlinkSync } = await import('node:fs');
          unlinkSync(lockPath);
        }
      }
    } catch {
      process.stderr.write('Failed to release test-container run lock.\n');
    }
  }
}

if (process.argv[1]?.toLowerCase().endsWith('runner.cjs')) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
