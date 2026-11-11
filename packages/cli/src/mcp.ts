import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  cancelRun,
  doctor,
  getFailure,
  getGroup,
  getRun,
  listRuns,
  readVersion,
  rerunGroup,
  startRun,
  waitRun,
} from './service.js';

function text(value: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  return {
    content: [
      {
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value),
      },
    ],
  };
}

function errorText(error: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  const message = error instanceof Error ? error.message : String(error);
  const [problem, ...rest] = message.split('\n');
  return {
    content: [
      {
        type: 'text',
        text: `${problem.slice(0, 300)}\n${(rest.join('\n') || 'fix: check the project path and configuration.').slice(0, 300)}`,
      },
    ],
    isError: true,
  };
}

function selectGroupDetails(
  value: unknown,
  include?: Array<'tests' | 'evidence' | 'candidates' | 'error' | 'artifacts'>,
): unknown {
  if (!include?.length || !value || typeof value !== 'object') return value;
  const { tests, suggestion, ...group } = value as {
    tests?: Array<Record<string, unknown>>;
    suggestion?: unknown;
    [key: string]: unknown;
  };
  const rows = tests ?? [];
  const selected: Record<string, unknown> = group;
  if (include.includes('tests'))
    selected.tests = rows.map(({ id, file, line, project, title, tags }) => ({
      id,
      file,
      line,
      project,
      title,
      tags,
    }));
  if (include.includes('evidence'))
    selected.evidence = rows.map(
      ({ id, attempts, classification, stable }) => ({
        id,
        attempts,
        classification,
        stable,
      }),
    );
  if (include.includes('candidates')) selected.suggestion = suggestion;
  if (include.includes('error'))
    selected.errors = rows.map(({ id, error }) => ({ id, error }));
  if (include.includes('artifacts'))
    selected.artifacts = rows.map(({ id, artifacts }) => ({ id, artifacts }));
  return selected;
}

// The project is fixed when the server starts, so a client can run and read only
// that project. Pass --project-root to `test-container mcp` to choose it.
export function createServer(root: string): McpServer {
  const server = new McpServer({
    name: 'test-container',
    version: readVersion(),
  });

  server.registerTool(
    'start_run',
    {
      description:
        'Start a filtered Playwright run. Then call wait_run until it finishes.',
      inputSchema: {
        tags: z.array(z.string()).min(1),
        match: z.enum(['any', 'all']).optional(),
        grep: z.string().optional(),
        grepInvert: z.string().optional(),
        projects: z.array(z.string()).optional(),
        workers: z.number().int().min(1).max(32).optional(),
        rerun: z.number().int().min(0).max(3).optional(),
        env: z.record(z.string(), z.string()).optional(),
        runtime: z.enum(['docker', 'native', 'auto']).optional(),
      },
    },
    async (input) => {
      try {
        const { run, selected } = await startRun({
          ...input,
          projectRoot: root,
        });
        return text(
          `run_id=${run.id} status=running selected=${selected} runtime=${run.runtime.mode}`,
        );
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    'wait_run',
    {
      description:
        'Wait for a run to finish; repeat if the returned status is running.',
      inputSchema: {
        run_id: z
          .string()
          .regex(/^\d{8}-\d{6}-[a-f0-9]{4}$/)
          .optional(),
        timeoutSeconds: z.number().int().min(10).max(3000).optional(),
      },
    },
    async ({ run_id, timeoutSeconds }) => {
      try {
        const result = await waitRun(root, run_id, timeoutSeconds ?? 300);
        if (
          result.run.status === 'running' ||
          result.run.status === 'starting'
        ) {
          return text(
            `running ${result.run.phase} ${result.run.counters.done}/${result.run.counters.selected} failed=${result.run.counters.failed}`,
          );
        }
        if (result.run.status === 'error')
          return errorText(
            `${result.run.error?.code}: ${result.run.error?.message}\nfix: ${result.run.error?.fix}`,
          );
        if (result.run.status === 'cancelled')
          return text(`cancelled ${result.run.id}`);
        return text(result.summary);
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    'get_summary',
    {
      description:
        'Return the compact summary for the latest or a selected run.',
      inputSchema: {
        run_id: z
          .string()
          .regex(/^\d{8}-\d{6}-[a-f0-9]{4}$/)
          .optional(),
        format: z.enum(['text', 'json']).optional(),
      },
    },
    async ({ run_id, format }) => {
      try {
        const result = getRun(root, run_id);
        return text(
          format === 'json'
            ? JSON.stringify(
                { run: result.run, groups: result.groups },
                null,
                0,
              )
            : result.summary,
        );
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    'get_group',
    {
      description: 'Get evidence for one group before acting on it.',
      inputSchema: {
        run_id: z
          .string()
          .regex(/^\d{8}-\d{6}-[a-f0-9]{4}$/)
          .optional(),
        group_id: z.string().regex(/^G\d+$/),
        include: z
          .array(
            z.enum(['tests', 'evidence', 'candidates', 'error', 'artifacts']),
          )
          .optional(),
      },
    },
    async ({ run_id, group_id, include }) => {
      try {
        return text(
          selectGroupDetails(getGroup(root, group_id, run_id), include),
        );
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    'get_failure',
    {
      description: 'Get detailed evidence for a failed test.',
      inputSchema: {
        run_id: z
          .string()
          .regex(/^\d{8}-\d{6}-[a-f0-9]{4}$/)
          .optional(),
        test: z.string().min(1).max(500),
      },
    },
    async ({ run_id, test }) => {
      try {
        return text(getFailure(root, test, run_id));
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    'rerun_group',
    {
      description:
        'Run only the tests in a previous failure group. Values passed earlier in env are not stored, so pass them again.',
      inputSchema: {
        run_id: z
          .string()
          .regex(/^\d{8}-\d{6}-[a-f0-9]{4}$/)
          .optional(),
        group_id: z.string().regex(/^G\d+$/),
        attempts: z.number().int().min(1).max(3).optional(),
        env: z.record(z.string(), z.string()).optional(),
      },
    },
    async ({ run_id, group_id, attempts, env }) => {
      try {
        const { run, selected } = await rerunGroup(
          root,
          group_id,
          run_id,
          attempts ?? 1,
          env,
        );
        return text(
          `run_id=${run.id} parent=${run_id ?? 'latest'} status=running selected=${selected} rerun=${attempts ?? 1}`,
        );
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    'list_runs',
    {
      description: 'List recent local runs.',
      inputSchema: { limit: z.number().int().min(1).max(20).optional() },
    },
    async ({ limit }) => {
      try {
        const rows = listRuns(root, limit ?? 5).map(
          (run) =>
            `${run.id} ${run.status} tags=${run.request.tags.join(',')} failed=${run.counters.failed} groups=${run.counters.groups ?? 0}`,
        );
        return text(rows.join('\n'));
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    'cancel_run',
    {
      description: 'Cancel the current or selected run.',
      inputSchema: {
        run_id: z
          .string()
          .regex(/^\d{8}-\d{6}-[a-f0-9]{4}$/)
          .optional(),
      },
    },
    async ({ run_id }) => {
      try {
        const run = await cancelRun(root, run_id);
        return text(
          run.status === 'cancelled'
            ? `cancelled ${run.id}`
            : `run ${run.id} already ${run.status}`,
        );
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    'doctor',
    {
      description: 'Check the local runtime and Playwright project.',
    },
    async () => {
      try {
        return text(doctor(root));
      } catch (error) {
        return errorText(error);
      }
    },
  );

  return server;
}

export async function startMcpServer(root = process.cwd()): Promise<void> {
  await createServer(root).connect(new StdioServerTransport());
}
