import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isSecretName,
  parseConfig,
  parseRules,
  secretValues,
  type TestContainerConfig,
} from '@scope/core';
import { RUN_LABEL } from './docker.js';
import { writeJsonAtomic, writeTextAtomic } from './files.js';
import {
  composeLocation,
  composeTagGrep,
  composeTagInvert,
  outputTail,
} from './runner.js';
import { javascriptArgs } from './runtime.js';

export type StartRunOptions = {
  tags: string[];
  match?: 'any' | 'all';
  grep?: string;
  grepInvert?: string;
  projects?: string[];
  workers?: number;
  rerun?: number;
  env?: Record<string, string>;
  runtime?: 'docker' | 'native' | 'auto';
  projectRoot?: string;
  onlyTests?: Array<{ file: string; line: number; project: string }>;
};

export type RunState = {
  id: string;
  status: 'starting' | 'running' | 'done' | 'error' | 'cancelled';
  phase: string;
  request: {
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
    // Names only. Values can be secrets, so they are never written to disk.
    envNames: string[];
  };
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

export type RunArtifacts = {
  run: RunState;
  summary: string;
  groups: unknown[];
  failures: unknown[];
};

const CONFIG_NAME = 'test-container.config.yml';
const CONFIG_NAMES = [
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
];
const packageDir = dirname(fileURLToPath(import.meta.url));

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function runtimeEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'HOME',
    'PATHEXT',
    'ComSpec',
    'ProgramData',
    'ProgramFiles',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_CONFIG',
    'DOCKER_CERT_PATH',
    'DOCKER_TLS_VERIFY',
    'XDG_RUNTIME_DIR',
  ];
  return Object.fromEntries(
    allowed.flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]],
    ),
  );
}

function findProjectRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    if (CONFIG_NAMES.some((name) => existsSync(join(current, name))))
      return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    'TC_E_PROJECT_NOT_FOUND: no playwright.config.{ts,js,mjs,cjs} found.',
  );
}

function getConfig(root: string): TestContainerConfig {
  const file = join(root, CONFIG_NAME);
  if (!existsSync(file)) return parseConfig('');
  try {
    return parseConfig(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `TC_E_CONFIG_INVALID: ${CONFIG_NAME}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function resolveProjectRoot(value?: string): {
  root: string;
  config: TestContainerConfig;
  workdir: string;
} {
  const root = value
    ? findProjectRoot(resolve(value))
    : findProjectRoot(process.cwd());
  const config = getConfig(root);
  const workdir = resolve(root, config.workdir);
  if (
    !CONFIG_NAMES.some((name) => existsSync(join(workdir, name))) &&
    config.playwright.config === null
  ) {
    throw new Error(
      `TC_E_PROJECT_NOT_FOUND: no Playwright config in workdir ${relative(root, workdir) || '.'}.`,
    );
  }
  return { root, config, workdir };
}

function getPlaywright(projectRoot: string): { cli: string; version: string } {
  const require = createRequire(join(projectRoot, 'package.json'));
  let manifest: string;
  let cli: string;
  try {
    manifest = require.resolve('@playwright/test/package.json');
    cli = require.resolve('@playwright/test/cli', { paths: [projectRoot] });
  } catch {
    try {
      manifest = require.resolve('playwright/package.json');
      cli = require.resolve('playwright/cli', { paths: [projectRoot] });
    } catch {
      throw new Error(
        'TC_E_PW_NOT_FOUND: install @playwright/test in the selected project.',
      );
    }
  }
  return { cli, version: readJson<{ version: string }>(manifest).version };
}

function engineAvailable(engine: string): boolean {
  return (
    spawnSync(engine, ['info'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    }).status === 0
  );
}

function makeRunId(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const timestamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${timestamp}-${randomBytes(2).toString('hex')}`;
}

function getProjectStore(root: string): string {
  const store = join(root, '.test-container');
  mkdirSync(store, { recursive: true });
  const gitignore = join(store, '.gitignore');
  if (!existsSync(gitignore)) writeFileSync(gitignore, '*\n');
  return store;
}

// EPERM means the process exists but belongs to another user.
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

type RunLock = { run_id: string; pid: number };

function readLock(lockFile: string): RunLock | undefined {
  try {
    const lock = readJson<Partial<RunLock>>(lockFile);
    return typeof lock.run_id === 'string' && typeof lock.pid === 'number'
      ? { run_id: lock.run_id, pid: lock.pid }
      : undefined;
  } catch {
    return undefined;
  }
}

// How long a lock file that cannot be read yet is assumed to be still in the
// middle of being written by the process that created it.
const LOCK_GRACE_MS = 5000;

const RUN_ID_PATTERN = /^\d{8}-\d{6}-[a-f0-9]{4}$/;

// Without this, the run whose lock is taken over would stay `running` for good.
function reapDeadRun(store: string, holder: RunLock | undefined): void {
  if (!holder || !RUN_ID_PATTERN.test(holder.run_id)) return;
  try {
    markRunnerDied(join(store, 'runs', holder.run_id));
  } catch {
    // The run folder is missing or unreadable; the lock is replaced anyway.
  }
}

export function acquireLock(store: string, runId: string): void {
  const lockFile = join(store, 'lock');
  const payload = JSON.stringify({ run_id: runId, pid: process.pid });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(lockFile, payload, { flag: 'wx' });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = readLock(lockFile);
    let age = Number.POSITIVE_INFINITY;
    try {
      age = Date.now() - statSync(lockFile).mtimeMs;
    } catch {
      continue;
    }
    if (holder ? processExists(holder.pid) : age < LOCK_GRACE_MS)
      throw new Error(
        `TC_E_RUN_IN_PROGRESS: run ${holder?.run_id ?? 'unknown'} is active.`,
      );
    reapDeadRun(store, holder);
    rmSync(lockFile, { force: true });
  }
  throw new Error('TC_E_RUN_IN_PROGRESS: could not acquire the run lock.');
}

export function releaseLock(store: string, runId: string): void {
  const lockFile = join(store, 'lock');
  if (readLock(lockFile)?.run_id === runId) rmSync(lockFile, { force: true });
}

// Variables that decide how the runner, Node.js, the dynamic loader or the
// container engine start. Whoever can set them can run code that is not part
// of the tests, so --env and MCP callers may not.
const RESERVED_ENV =
  /^(?:TC_.*|PATH|PATHEXT|COMSPEC|SYSTEMROOT|WINDIR|NODE_OPTIONS|NODE_PATH|BUN_OPTIONS|LD_.*|DYLD_.*|DOCKER_.*|CONTAINER_HOST)$/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Precedence, lowest to highest: the env file, `env.passthrough` variables from
// the process environment, then values supplied with --env. Secrets travel only
// through `env.passthrough`; the env file skips secret-looking names and --env
// rejects them, along with names that change how the tools start.
export function getEnv(
  config: TestContainerConfig,
  supplied: Record<string, string>,
  root: string,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const pattern = config.redaction.namePattern;
  const env: Record<string, string> = {};
  if (config.env.envFile) {
    const path = resolve(root, config.env.envFile);
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/.exec(line);
        if (match && !isSecretName(match[1], pattern))
          env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
      }
    }
  }
  for (const name of config.env.passthrough) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  for (const [name, value] of Object.entries(supplied)) {
    if (!ENV_NAME.test(name)) {
      throw new Error(
        `TC_E_CONFIG_INVALID: ${JSON.stringify(name)} is not a valid environment variable name.`,
      );
    }
    if (RESERVED_ENV.test(name)) {
      throw new Error(
        `TC_E_CONFIG_INVALID: ${name} is reserved and cannot be set with --env.`,
      );
    }
    if (isSecretName(name, pattern)) {
      throw new Error(
        `TC_E_CONFIG_INVALID: ${name} looks like a secret and cannot be passed with --env. Export it and list it under env.passthrough.`,
      );
    }
    env[name] = value;
  }
  return env;
}

function selectionArgs(
  state: RunState,
  config: TestContainerConfig,
  reporterPath: string,
  outputDir: string,
): string[] {
  const args = ['test'];
  const configPath = config.playwright.config;
  if (configPath)
    args.push('--config', resolve(state.request.workdir, configPath));
  const grep = composeTagGrep(
    state.request.tags,
    state.request.match,
    state.request.grep,
  );
  const noRunTags = [...config.playwright.noRunTags];
  const invert = composeTagInvert(state.request.grepInvert, noRunTags);
  if (grep) args.push('--grep', grep);
  if (invert) args.push('--grep-invert', invert);
  for (const project of state.request.projects) args.push('--project', project);
  args.push(
    '--workers',
    String(state.request.workers),
    '--retries=0',
    '--output',
    outputDir,
    '--reporter',
    reporterPath,
    '--list',
  );
  for (const test of state.request.onlyTests ?? []) {
    args.push(
      composeLocation(resolve(state.request.projectRoot, test.file), test.line),
    );
  }
  for (const arg of config.playwright.extraArgs) {
    if (/^--(?:output|reporter|retries)(?:=|$)/.test(arg)) {
      throw new Error(
        `TC_E_CONFIG_INVALID: playwright.extraArgs cannot override ${arg}.`,
      );
    }
    args.push(arg);
  }
  return args;
}

const SELECTION_TIMEOUT_MS = 5 * 60 * 1000;

function selectTests(
  state: RunState,
  config: TestContainerConfig,
  cli: string,
  runDir: string,
  testEnv: Record<string, string>,
): number {
  const reporterPath = join(packageDir, 'reporter.cjs');
  if (!existsSync(reporterPath))
    throw new Error(
      'Build the package before running it: reporter.cjs is missing.',
    );
  const eventsPath = join(runDir, 'selection.json');
  const env = {
    ...runtimeEnvironment(),
    ...testEnv,
    TC_MODE: 'list',
    TC_EVENTS_FILE: eventsPath,
    TC_RUN_DIR: runDir,
  };
  const result = spawnSync(
    process.execPath,
    javascriptArgs([
      cli,
      ...selectionArgs(state, config, reporterPath, join(runDir, 'pw-output')),
    ]),
    {
      cwd: state.request.workdir,
      env,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      timeout: SELECTION_TIMEOUT_MS,
    },
  );
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT')
      throw new Error(
        `TC_E_PLAYWRIGHT_CRASH: test selection did not finish within ${SELECTION_TIMEOUT_MS / 60000} minutes.`,
      );
    throw result.error;
  }
  if (result.status !== 0)
    throw new Error(
      `TC_E_PLAYWRIGHT_CRASH: test selection failed: ${outputTail(
        result.stderr || result.stdout,
        secretValues(testEnv, config.redaction.namePattern),
      )}`,
    );
  const data = readJson<{ selected: number }>(eventsPath);
  if (data.selected === 0)
    throw new Error(
      `TC_E_NO_TESTS: no tests selected for tags ${state.request.tags.join(',')}.`,
    );
  return data.selected;
}

function latestRunId(store: string): string | undefined {
  const path = join(store, 'latest');
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : undefined;
}

function runDirectory(root: string, runId?: string): string {
  const store = getProjectStore(findProjectRoot(root));
  const id = runId ?? latestRunId(store);
  if (!id || !RUN_ID_PATTERN.test(id))
    throw new Error('TC_E_RUN_NOT_FOUND: valid run id not found.');
  const path = resolve(store, 'runs', id);
  const prefix = `${resolve(store, 'runs')}${sep}`;
  if (!path.startsWith(prefix))
    throw new Error('TC_E_RUN_NOT_FOUND: invalid run id.');
  if (!existsSync(join(path, 'run.json')))
    throw new Error(`TC_E_RUN_NOT_FOUND: run ${id} not found.`);
  return path;
}

export async function startRun(
  options: StartRunOptions,
): Promise<{ run: RunState; selected: number }> {
  if (!options.tags?.length)
    throw new Error('TC_E_CONFIG_INVALID: at least one tag is required.');
  const { root, config, workdir } = resolveProjectRoot(options.projectRoot);
  const playwright = getPlaywright(workdir);
  const store = getProjectStore(root);
  const runId = makeRunId();
  const runDir = join(store, 'runs', runId);
  const runtimeChoice = options.runtime ?? config.runtime;
  const runtime =
    runtimeChoice === 'auto'
      ? engineAvailable(config.docker.engine)
        ? 'docker'
        : 'native'
      : runtimeChoice;
  if (runtime === 'docker' && !engineAvailable(config.docker.engine)) {
    throw new Error(
      `TC_E_ENGINE_UNAVAILABLE: ${config.docker.engine} is not running; start it or choose runtime=native.`,
    );
  }
  const effectiveEnv = getEnv(config, options.env ?? {}, root);
  const state: RunState = {
    id: runId,
    status: 'starting',
    phase: 'preflight',
    request: {
      tags: options.tags.map((tag) => (tag.startsWith('@') ? tag : `@${tag}`)),
      match: options.match ?? config.tags.match,
      grep: options.grep,
      grepInvert: options.grepInvert,
      projects: options.projects ?? config.playwright.projects,
      workers: options.workers ?? config.playwright.workers,
      rerunAttempts: options.rerun ?? config.rerun.attempts,
      runtime,
      projectRoot: root,
      workdir,
      onlyTests: options.onlyTests,
      envNames: Object.keys(effectiveEnv).sort(),
    },
    runtime: { mode: runtime },
    versions: {
      playwright: playwright.version,
      testContainer: readVersion(),
      node: process.version,
      bun: process.versions.bun,
    },
    counters: { selected: 0, done: 0, passed: 0, failed: 0, skipped: 0 },
    startedAt: new Date().toISOString(),
  };
  acquireLock(store, runId);
  let spawned = false;
  try {
    mkdirSync(join(runDir, 'logs'), { recursive: true });
    state.counters.selected = selectTests(
      state,
      config,
      playwright.cli,
      runDir,
      effectiveEnv,
    );
    writeJsonAtomic(join(runDir, 'run.json'), state);
    writeTextAtomic(join(store, 'latest'), `${runId}\n`);
    const runnerPath = join(packageDir, 'runner.cjs');
    if (!existsSync(runnerPath))
      throw new Error(
        'Build the package before running it: runner.cjs is missing.',
      );
    const child = spawn(
      process.execPath,
      javascriptArgs([runnerPath, 'pipeline', '--run-dir', runDir]),
      {
        cwd: root,
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        env: {
          ...runtimeEnvironment(),
          ...effectiveEnv,
          TC_RUN_DIR: runDir,
          TC_PLAYWRIGHT_CONFIG: config.playwright.config ?? '',
          TC_EXTRA_ARGS: JSON.stringify(config.playwright.extraArgs),
          TC_NO_RUN_TAGS: JSON.stringify(config.playwright.noRunTags),
          TC_BACKOFF_SECONDS: JSON.stringify(config.rerun.backoffSeconds),
          TC_RERUN_NO_TAGS: JSON.stringify(config.rerun.noRerunTags),
          TC_RERUN_WORKERS: String(config.rerun.workers),
          TC_CONFIG: JSON.stringify(config),
          TC_RUN_ID: runId,
        },
      },
    );
    if (!child.pid) throw new Error('Failed to start the detached runner.');
    spawned = true;
    child.unref();
    state.status = 'running';
    state.runtime.pid = child.pid;
    writeTextAtomic(
      join(store, 'lock'),
      JSON.stringify({ run_id: runId, pid: child.pid }),
    );
    writeJsonAtomic(join(runDir, 'run.json'), state);
    return { run: state, selected: state.counters.selected };
  } catch (error) {
    // Once the runner exists it owns the lock and the run folder.
    if (!spawned) {
      releaseLock(store, runId);
      rmSync(runDir, { recursive: true, force: true });
    }
    throw error;
  }
}

export async function rerunGroup(
  root: string,
  groupId: string,
  runId?: string,
  attempts = 1,
  env: Record<string, string> = {},
): Promise<{ run: RunState; selected: number }> {
  const parent = getRun(root, runId);
  const group = parent.groups.find(
    (candidate) => (candidate as { id?: string }).id === groupId,
  ) as { testIds?: string[] } | undefined;
  if (!group?.testIds?.length)
    throw new Error(`TC_E_GROUP_NOT_FOUND: ${groupId}.`);
  const selectedIds = new Set(group.testIds);
  const onlyTests = parent.failures
    .filter((failure) => selectedIds.has((failure as { id: string }).id))
    .map((failure) => {
      const item = failure as { file: string; line: number; project: string };
      return { file: item.file, line: item.line, project: item.project };
    });
  const { request } = parent.run;
  // Values given with --env are never stored, so the caller supplies them again.
  return startRun({
    tags: request.tags,
    match: request.match,
    grep: request.grep,
    grepInvert: request.grepInvert,
    projects: [...new Set(onlyTests.map((test) => test.project))],
    workers: request.workers,
    runtime: request.runtime,
    projectRoot: request.projectRoot,
    onlyTests,
    rerun: attempts,
    env,
  });
}

export function readVersion(): string {
  try {
    return readJson<{ version: string }>(join(packageDir, '..', 'package.json'))
      .version;
  } catch {
    return '0.1.0';
  }
}

export function getRun(root: string, runId?: string): RunArtifacts {
  const dir = runDirectory(root, runId);
  const run = readJson<RunState>(join(dir, 'run.json'));
  const failures = existsSync(join(dir, 'failures.json'))
    ? readJson<{ groups: unknown[]; failures: unknown[] }>(
        join(dir, 'failures.json'),
      )
    : { groups: [], failures: [] };
  const summary = existsSync(join(dir, 'summary.md'))
    ? readFileSync(join(dir, 'summary.md'), 'utf8')
    : '';
  return { run, summary, groups: failures.groups, failures: failures.failures };
}

function isActive(state: RunState): boolean {
  return state.status === 'starting' || state.status === 'running';
}

// A runner that was killed or crashed leaves its run in `running` for good, so
// waiting on that run would never end.
function markRunnerDied(dir: string): RunState {
  const state = readJson<RunState>(join(dir, 'run.json'));
  if (!isActive(state)) return state;
  state.status = 'error';
  state.phase = 'error';
  state.endedAt = new Date().toISOString();
  state.error = {
    code: 'TC_E_RUNNER_DIED',
    message: 'The runner process exited before it finished the run.',
    fix: 'Check the logs folder of the run, then start the run again.',
  };
  writeJsonAtomic(join(dir, 'run.json'), state);
  releaseLock(dirname(dirname(dir)), state.id);
  return state;
}

export async function waitRun(
  root: string,
  runId?: string,
  timeoutSeconds = 300,
): Promise<RunArtifacts> {
  const dir = runDirectory(root, runId);
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (true) {
    let state = readJson<RunState>(join(dir, 'run.json'));
    if (
      isActive(state) &&
      state.runtime.pid &&
      !processExists(state.runtime.pid)
    )
      // The runner may have written its final state just before exiting.
      state = markRunnerDied(dir);
    if (!isActive(state) || Date.now() >= deadline)
      return getRun(root, state.id);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
}

export function listRuns(root = process.cwd(), limit = 5): RunState[] {
  let project: string;
  try {
    project = findProjectRoot(root);
  } catch {
    project = resolve(root);
  }
  const runsDir = join(project, '.test-container', 'runs');
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, Math.max(1, Math.min(20, limit)))
    .flatMap((entry) => {
      const statePath = join(runsDir, entry.name, 'run.json');
      try {
        return [readJson<RunState>(statePath)];
      } catch {
        return [];
      }
    });
}

export function getGroup(
  root: string,
  groupId: string,
  runId?: string,
): unknown {
  if (!/^G\d+$/.test(groupId))
    throw new Error('TC_E_GROUP_NOT_FOUND: invalid group id.');
  const run = getRun(root, runId);
  const group = run.groups.find(
    (candidate) => (candidate as { id?: string }).id === groupId,
  ) as { testIds?: string[] } | undefined;
  if (!group) throw new Error(`TC_E_GROUP_NOT_FOUND: ${groupId}.`);
  const ids = new Set(group.testIds ?? []);
  return {
    ...group,
    tests: run.failures.filter((failure) =>
      ids.has((failure as { id: string }).id),
    ),
  };
}

export function getFailure(
  root: string,
  test: string,
  runId?: string,
): unknown {
  const run = getRun(root, runId);
  const failure = run.failures.find((candidate) => {
    const item = candidate as { id?: string; file?: string; line?: number };
    return item.id === test || `${item.file}:${item.line}` === test;
  });
  if (!failure)
    throw new Error(`TC_E_RUN_NOT_FOUND: failure ${test} not found.`);
  return failure;
}

export async function cancelRun(
  root: string,
  runId?: string,
): Promise<RunState> {
  const dir = runDirectory(root, runId);
  const state = readJson<RunState>(join(dir, 'run.json'));
  if (!isActive(state)) return state;
  const pid = state.runtime.pid;
  if (pid && processExists(pid)) {
    if (process.platform === 'win32') {
      await new Promise<void>((resolvePromise, reject) => {
        const child = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
          windowsHide: true,
        });
        child.once('error', reject);
        child.once('close', () => resolvePromise());
      });
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch (error) {
        // The runner may have exited between the check and the signal.
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }
  if (state.request.runtime === 'docker') {
    let engine = 'docker';
    try {
      engine = getConfig(state.request.projectRoot).docker.engine;
    } catch {
      // An edited or broken config must not leave the run marked as running.
    }
    const listed = spawnSync(
      engine,
      ['ps', '-aq', '--filter', `label=${RUN_LABEL}=${state.id}`],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 },
    );
    const ids = (listed.stdout ?? '').split(/\s+/).filter(Boolean);
    if (ids.length)
      spawnSync(engine, ['rm', '-f', ...ids], {
        windowsHide: true,
        timeout: 30000,
      });
  }
  state.status = 'cancelled';
  state.phase = 'cancelled';
  state.endedAt = new Date().toISOString();
  writeJsonAtomic(join(dir, 'run.json'), state);
  releaseLock(dirname(dirname(dir)), state.id);
  return state;
}

export function cleanRuns(root = process.cwd(), keep = 10): number {
  const project = findProjectRoot(root);
  const runsDir = join(project, '.test-container', 'runs');
  if (!existsSync(runsDir)) return 0;
  const runs = readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name));
  let removed = 0;
  for (const entry of runs.slice(Math.max(0, keep))) {
    const path = resolve(runsDir, entry.name);
    const prefix = `${resolve(runsDir)}${sep}`;
    if (!path.startsWith(prefix)) continue;
    rmSync(path, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

export function doctor(root = process.cwd()): string {
  const checks: string[] = [
    process.versions.bun
      ? `ok bun ${process.versions.bun} (Node.js compatibility ${process.version})`
      : `ok node ${process.version}`,
  ];
  try {
    const project = findProjectRoot(root);
    const { config, workdir } = resolveProjectRoot(project);
    const { version } = getPlaywright(workdir);
    checks.push(`ok project ${relative(process.cwd(), project) || '.'}`);
    checks.push(`ok Playwright ${version}`);
    const store = getProjectStore(project);
    const probe = join(store, `.doctor-${process.pid}`);
    writeFileSync(probe, '');
    rmSync(probe, { force: true });
    checks.push('ok .test-container writable');
    checks.push(`info runtime ${config.runtime}`);
    if (engineAvailable(config.docker.engine)) {
      checks.push(`ok ${config.docker.engine} available`);
    } else
      checks.push(
        `warn ${config.docker.engine} unavailable; native mode is available`,
      );
  } catch (error) {
    checks.push(
      `fail ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return checks.join('\n');
}

export function initProject(root = process.cwd(), write = false): string {
  const files: Record<string, string> = {
    [CONFIG_NAME]: 'version: 1\nruntime: auto\n',
    'test-container.rules.yml': 'version: 1\nrules: []\n',
    'test-container.known-issues.yml': 'version: 1\nissues: []\n',
  };
  if (!write)
    return Object.entries(files)
      .map(([name, content]) => `--- ${name} ---\n${content}`)
      .join('\n');
  const project = resolve(root);
  if (!existsSync(project))
    throw new Error(`TC_E_PROJECT_NOT_FOUND: ${project} does not exist.`);
  const created: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const path = join(project, name);
    if (!existsSync(path)) {
      writeFileSync(path, content);
      created.push(name);
    }
  }
  return created.length
    ? `created ${created.join(', ')}`
    : 'no files created; configuration files already exist';
}

export function ensureRulesValid(
  projectRoot: string,
  config: TestContainerConfig,
): void {
  const path = join(projectRoot, config.classification.rules);
  if (existsSync(path)) parseRules(readFileSync(path, 'utf8'));
}
