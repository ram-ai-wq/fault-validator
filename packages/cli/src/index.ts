#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  cancelRun,
  cleanRuns,
  doctor,
  getFailure,
  getGroup,
  getRun,
  initProject,
  listRuns,
  type RunArtifacts,
  readVersion,
  rerunGroup,
  startRun,
  waitRun,
} from './service.js';

const usage = `Usage: test-container <command> [options]

Commands:
  init [--write]                 Show or create project configuration
  doctor                         Check the local setup
  run --tags @a,@b [options]     Start a filtered Playwright run
  wait [run_id] [--timeout min]  Wait for a run to finish
  summary [run_id] [--json]      Show the compact run summary
  group <G1> [run_id]            Show group details
  failure <test> [run_id]        Show failure details
  rerun-group <G1> [run_id]      Start a run for one group
  runs [--limit n]               List recent runs
  cancel [run_id]                Cancel a run
  clean [--keep n]               Prune old runs inside .test-container
  mcp                            Start the MCP server on stdio

Every command also accepts --project-root <path>, which defaults to the current
directory. run and rerun-group also accept --env NAME=value.`;

const DEFAULT_WAIT_MINUTES = 300;

function takeValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--'))
    throw new Error(`TC_E_CONFIG_INVALID: ${name} requires a value.`);
  args.splice(index, 2);
  return value;
}

function takeEnv(args: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--env') continue;
    const entry = args[index + 1] ?? '';
    const separator = entry.indexOf('=');
    if (separator < 1)
      throw new Error('TC_E_CONFIG_INVALID: --env requires KEY=VALUE.');
    env[entry.slice(0, separator)] = entry.slice(separator + 1);
    args.splice(index, 2);
    index -= 1;
  }
  return env;
}

function parseInteger(
  value: string | undefined,
  flag: string,
): number | undefined;
function parseInteger(
  value: string | undefined,
  flag: string,
  fallback: number,
): number;
function parseInteger(
  value: string | undefined,
  flag: string,
  fallback?: number,
): number | undefined {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(
      `TC_E_CONFIG_INVALID: ${flag} must be a non-negative integer.`,
    );
  return parsed;
}

function assertNoOptions(args: string[]): void {
  const unknown = args.find((arg) => arg.startsWith('-'));
  if (unknown)
    throw new Error(`TC_E_CONFIG_INVALID: unknown option ${unknown}.`);
}

// Exit codes: 0 the run finished (failed tests are reported in the summary, not
// in the code), 2 usage or configuration error, 3 container engine or
// Playwright missing, 4 the run did not finish or something else went wrong.
const USAGE_ERRORS = new Set([
  'TC_E_CONFIG_INVALID',
  'TC_E_PROJECT_NOT_FOUND',
  'TC_E_NO_TESTS',
  'TC_E_RUN_NOT_FOUND',
  'TC_E_GROUP_NOT_FOUND',
]);

function exitCodeFor(code: string | undefined): number {
  if (!code) return 4;
  if (code.startsWith('TC_E_ENGINE') || code.startsWith('TC_E_PW')) return 3;
  return USAGE_ERRORS.has(code) ? 2 : 4;
}

function reportOutcome(result: RunArtifacts): number {
  const { run } = result;
  if (run.status === 'error') {
    console.error(
      `${run.error?.code}: ${run.error?.message}\nfix: ${run.error?.fix}`,
    );
    return exitCodeFor(run.error?.code);
  }
  if (run.status === 'cancelled') {
    console.error(`TC_E_RUN_CANCELLED: run ${run.id} was cancelled.`);
    return 4;
  }
  if (run.status !== 'done') {
    console.log(
      `running ${run.phase} ${run.counters.done}/${run.counters.selected} failed=${run.counters.failed}`,
    );
    console.error(
      `TC_E_WAIT_TIMEOUT: run ${run.id} is still ${run.status}. Wait again with: test-container wait ${run.id}`,
    );
    return 4;
  }
  console.log(result.summary);
  return 0;
}

async function runCommand(args: string[], root: string): Promise<number> {
  const tags =
    takeValue(args, '--tags')
      ?.split(',')
      .map((tag) => tag.trim())
      .filter(Boolean) ?? [];
  const match = takeValue(args, '--match') as 'any' | 'all' | undefined;
  const grep = takeValue(args, '--grep');
  const grepInvert = takeValue(args, '--grep-invert');
  const workers = parseInteger(takeValue(args, '--workers'), '--workers');
  const rerun = parseInteger(takeValue(args, '--rerun'), '--rerun');
  const runtime = takeValue(args, '--runtime') as
    | 'docker'
    | 'native'
    | 'auto'
    | undefined;
  const timeout = takeValue(args, '--timeout');
  const waitMinutes = parseInteger(timeout, '--timeout', DEFAULT_WAIT_MINUTES);
  const projects = args.flatMap((arg, index) =>
    arg === '--project' && args[index + 1] ? [args[index + 1]] : [],
  );
  for (let index = args.length - 1; index >= 0; index -= 1) {
    if (args[index] === '--project') args.splice(index, 2);
  }
  const env = takeEnv(args);
  const wait = args.includes('--wait');
  if (wait) args.splice(args.indexOf('--wait'), 1);
  assertNoOptions(args);
  if (args.length)
    throw new Error(`TC_E_CONFIG_INVALID: unexpected argument ${args[0]}.`);
  if (!tags.length)
    throw new Error('TC_E_CONFIG_INVALID: use --tags @tag[,tag].');
  if (timeout !== undefined && !wait)
    throw new Error('TC_E_CONFIG_INVALID: --timeout only applies with --wait.');
  if (match && !['any', 'all'].includes(match))
    throw new Error('TC_E_CONFIG_INVALID: --match must be any or all.');
  if (runtime && !['docker', 'native', 'auto'].includes(runtime))
    throw new Error(
      'TC_E_CONFIG_INVALID: --runtime must be docker, native, or auto.',
    );
  const { run, selected } = await startRun({
    tags,
    match,
    grep,
    grepInvert,
    projects,
    workers,
    rerun,
    runtime,
    projectRoot: root,
    env,
  });
  if (!wait) {
    console.log(
      `run_id=${run.id} status=running selected=${selected} runtime=${run.runtime.mode}`,
    );
    return 0;
  }
  return reportOutcome(await waitRun(root, run.id, waitMinutes * 60));
}

function commandRunId(args: string[]): string | undefined {
  const id = args.find((arg) => !arg.startsWith('-'));
  if (id) args.splice(args.indexOf(id), 1);
  return id;
}

async function main(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    console.log(`test-container v${readVersion()}`);
    return 0;
  }
  const command = args.shift();
  if (!command || command === '--help' || command === '-h') {
    console.log(usage);
    return 0;
  }
  const root = resolve(takeValue(args, '--project-root') ?? process.cwd());
  switch (command) {
    case 'init': {
      const write = args.includes('--write');
      if (write) args.splice(args.indexOf('--write'), 1);
      assertNoOptions(args);
      console.log(initProject(root, write));
      return 0;
    }
    case 'doctor':
      assertNoOptions(args);
      console.log(doctor(root));
      return 0;
    case 'run':
      return runCommand(args, root);
    case 'wait': {
      const minutes = parseInteger(
        takeValue(args, '--timeout'),
        '--timeout',
        DEFAULT_WAIT_MINUTES,
      );
      const id = commandRunId(args);
      assertNoOptions(args);
      return reportOutcome(await waitRun(root, id, minutes * 60));
    }
    case 'summary': {
      const id = commandRunId(args);
      const json = args.includes('--json');
      if (json) args.splice(args.indexOf('--json'), 1);
      assertNoOptions(args);
      const result = getRun(root, id);
      console.log(
        json
          ? JSON.stringify({ run: result.run, groups: result.groups }, null, 0)
          : result.summary,
      );
      return 0;
    }
    case 'group': {
      const group = args.shift();
      const id = commandRunId(args);
      assertNoOptions(args);
      if (!group) throw new Error('TC_E_CONFIG_INVALID: group id is required.');
      console.log(JSON.stringify(getGroup(root, group, id), null, 2));
      return 0;
    }
    case 'failure': {
      const test = args.shift();
      const id = commandRunId(args);
      assertNoOptions(args);
      if (!test)
        throw new Error(
          'TC_E_CONFIG_INVALID: test id or file:line is required.',
        );
      console.log(JSON.stringify(getFailure(root, test, id), null, 2));
      return 0;
    }
    case 'rerun-group': {
      const env = takeEnv(args);
      assertNoOptions(args);
      const group = args.shift();
      const id = commandRunId(args);
      if (!group) throw new Error('TC_E_CONFIG_INVALID: group id is required.');
      const result = await rerunGroup(root, group, id, 1, env);
      console.log(
        `run_id=${result.run.id} status=running selected=${result.selected}`,
      );
      return 0;
    }
    case 'runs': {
      const limit = parseInteger(takeValue(args, '--limit'), '--limit', 5);
      assertNoOptions(args);
      for (const run of listRuns(root, limit)) {
        console.log(
          `${run.id} ${run.status} tags=${run.request.tags.join(',')} failed=${run.counters.failed} groups=${run.counters.groups ?? 0}`,
        );
      }
      return 0;
    }
    case 'cancel': {
      const id = commandRunId(args);
      assertNoOptions(args);
      const run = await cancelRun(root, id);
      console.log(
        run.status === 'cancelled'
          ? `cancelled ${run.id}`
          : `run ${run.id} already ${run.status}`,
      );
      return 0;
    }
    case 'clean': {
      const keep = parseInteger(takeValue(args, '--keep'), '--keep', 10);
      assertNoOptions(args);
      console.log(`removed ${cleanRuns(root, keep)} old runs`);
      return 0;
    }
    case 'mcp': {
      assertNoOptions(args);
      const { startMcpServer } = await import('./mcp.js');
      await startMcpServer(root);
      return 0;
    }
    default:
      throw new Error(
        `TC_E_CONFIG_INVALID: unknown command ${command}.\n${usage}`,
      );
  }
}

export async function runCli(args: string[]): Promise<number> {
  try {
    return await main([...args]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `${message.split('\n')[0]}\nfix: check the command, project configuration, and local dependencies.`,
    );
    return exitCodeFor(/^(TC_E_[A-Z_]+):/.exec(message)?.[1]);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  process.exitCode = await runCli(process.argv.slice(2));
}
