# CLI

Compile the workspace with `bun run build`, then invoke the CLI from the checkout
root. Every command acts on the project in the current directory. Add
`--project-root <path>` after the command name to act on a different Playwright
project.

```sh
bun run cli run --tags @demo --runtime native --project-root examples/demo-tests --wait
```

Run `init --write` from the target project's directory to create its
configuration. Use `summary`, `group <id>`, `failure <id>`, and `runs` to
inspect results. `rerun-group <id>` runs one group's tests again; pass any
`--env NAME=value` it needs again, because values are never stored.

## MCP server

`mcp` starts the MCP server over standard input and output. It serves one
project folder, the one given by `--project-root` (the current directory by
default). MCP clients cannot choose another folder, and the tools take no
project path. Configure a client with this command, using absolute paths:

```sh
bun --no-env-file /absolute/path/to/packages/cli/dist/index.js mcp --project-root /absolute/path/to/test-project
```

Replace `bun --no-env-file` with `node` to retain Node.js execution.

## Waiting and exit codes

`run --wait` and `wait` block until the run finishes. `--timeout <minutes>`
limits that wait (300 by default) and is accepted only with `--wait` and on
`wait`. It does not stop the run, which keeps going in the background; use
`cancel` for that. The MCP tool `wait_run` takes `timeoutSeconds` instead.

If the runner process disappears before it finishes (for example after a crash
or a reboot), `wait` marks the run `error` with `TC_E_RUNNER_DIED` and releases
the project's run lock instead of waiting forever.

| Code | Meaning                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`  | The command succeeded. After `run --wait` or `wait`, the run finished; failed tests are reported in the summary, not in the exit code.           |
| `2`  | Usage or configuration error: bad options or `test-container.config.yml`, project, run, or group not found, or no test matches the selection.    |
| `3`  | The container engine or `@playwright/test` is missing or unavailable.                                                                            |
| `4`  | The run ended in `error` (including a Playwright crash or a failed dependency install), was cancelled, or was still running when the wait ended. |

## Runtime selection

`--runtime native` runs Playwright on the host. `--runtime docker` runs each
execution and re-run phase in `mcr.microsoft.com/playwright:v<version>-noble`
(or `docker.image`), with the project mounted at `/work` and `node_modules`
installed from the lockfile into a per-project volume. `--runtime auto` picks
`docker` when `docker info` (or `podman info`) succeeds. The container prepare
step writes `logs/container.prepare.log` in the run folder, and `cancel`
removes containers labelled `test-container.run=<run_id>`.

The CLI's executable selects the JavaScript runtime: launching with Bun uses
Bun for selection, the detached runner, Playwright workers, and container
execution. Launching with Node.js retains Node.js execution. `--runtime`
continues to mean `native`, `docker`, or `auto`, not the JavaScript runtime.
Run metadata records `versions.bun` when Bun is active; `doctor` identifies it.

Bun container dependencies use `bun.lock` or `bun.lockb` and a pinned Bun
installer (`packageManager` version, or 1.4.4 by default). Explicit
`packageManager` declarations take precedence over other lockfiles. The
container's Bun executable is cached separately from the install marker so it
remains available for later phases and cache hits.
