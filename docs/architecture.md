# Architecture

`test-container` keeps its decision logic in a pure TypeScript core and puts
everything that touches the file system, child processes, containers, or MCP
clients in thin adapters. See
[ADR 0001](decisions/0001-hexagonal-typescript-workspace.md) for the decision
record.

## Packages

| Package         | Responsibility                                                                                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core` | Pure logic with no process, network, or file-system I/O: configuration schema, error parsing, failure signatures, classification rules, grouping, ARIA-based locator suggestions, redaction, and summaries. |
| `packages/cli`  | The adapters: CLI, run service, detached runner, Playwright reporter, container runtime, and MCP server.                                                                                                    |

## Adapters in `packages/cli`

- `index.ts` parses commands and prints results.
- `service.ts` resolves the project and configuration, selects tests on the
  host, owns the run store and the per-project lock, and starts, cancels, and
  diagnoses runs.
- `runner.ts` is the detached pipeline: first execution, failure re-runs,
  classification, report writing, and secret redaction.
- `reporter.ts` is a Playwright reporter that writes a JSON event file for each
  phase, including attachments such as traces and ARIA snapshots.
- `docker.ts` resolves the image, installs and caches dependencies, maps paths
  between host and container, and builds the engine arguments.
- `mcp.ts` is the stdio MCP server, bound to the single project folder its
  operator chose. It exposes `start_run`, `wait_run`, `get_summary`,
  `get_group`, `get_failure`, `rerun_group`, `list_runs`, `cancel_run`, and
  `doctor`; none of them takes a project path.
- `runtime.ts` keeps child processes on the JavaScript runtime that launched
  the CLI (Bun or Node.js).

## Run lifecycle

1. `run` loads the configuration and asks Playwright for the tests that match
   the tags and filters. Selection always runs on the host.
2. The service takes a lock so that a project has one active run at a time,
   then creates `.test-container/runs/<run_id>/` and writes `run.json`. A lock
   whose process is gone is replaced, and the run it belonged to is marked
   `error`.
3. The service starts the runner as a detached process with an allowlisted
   environment, so the run continues after the launching command exits. The
   values of forwarded variables travel only through that environment; the run
   state keeps their names.
4. The runner executes the selected tests natively or in a container, re-runs
   failures with the configured backoff, then classifies and groups what still
   fails.
5. The runner writes the reports, redacts secret values and secret-shaped text
   from the text artifacts, updates `run.json`, and releases the lock.

`run.json`, `latest`, and the lock are written atomically (a temporary file,
then a rename), so a concurrent reader never sees a half-written file. If the
runner fails, it redacts the run folder before it records the `error` state. If
the runner process disappears without finishing, `wait` or the next `run` marks
its run `error` with `TC_E_RUNNER_DIED` and frees the lock.

Apart from starting, cancelling, and settling a run whose runner died, the CLI
and the MCP server only read the run folder, so any client can inspect a
finished run.

## Run folder

```text
.test-container/runs/<run_id>/
  run.json         state, request, counters, and versions
                   (environment variables appear by name only)
  selection.json   number of selected tests
  summary.md       compact summary
  groups/G1.md     one file per failure group
  failures.json    failures with attempts, evidence, and classification
  events.*.json    reporter events for each phase
  logs/            runner, Playwright, and container logs
  pw-output/       traces and error contexts from Playwright
```

`.test-container/` ignores itself in Git.
