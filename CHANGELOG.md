# Changelog

All notable changes will be documented here. This project follows
[Semantic Versioning](https://semver.org/).

## Unreleased

- Select Playwright tests by tag with `any` or `all` matching, plus grep and
  project filters.
- Run natively or in Docker or Podman with the official Playwright image.
- Re-run failures with a configurable backoff, and skip tests tagged
  `@no-rerun`.
- Classify and group failures deterministically, with custom rules and known
  issues.
- Suggest replacement locators from ARIA snapshots.
- Write compact local reports under `.test-container/runs/`.
- Expose runs, summaries, groups, and failures to coding agents through an MCP
  stdio server.
- Run the CLI on Bun or Node.js.
- Keep secrets out of run state: forward them only through `env.passthrough`,
  store variable names instead of values, and reject secret-looking names passed
  with `--env`. Reject names that steer the runner, Node.js, the dynamic loader,
  or the container engine (`TC_*`, `PATH`, `NODE_OPTIONS`, `LD_*`, `DOCKER_*`,
  and similar) the same way.
- Redact secret values, `Authorization` and `Cookie` headers, passwords inside
  URLs, JSON web tokens, and secret-named key/value pairs from the text
  artifacts in each run folder, including after a failed run.
- Reject unknown keys at every level of `test-container.config.yml`.
- Bind the MCP server to the single project folder chosen with
  `mcp --project-root`; the tools take no project path.
- Add `--project-root` to every command, `--env` to `rerun-group`, and
  `wait --timeout <minutes>`. `--timeout` now applies only with `--wait`.
- Return exit code `0` when a run finishes, `2` for usage and configuration
  errors, `3` when the container engine or Playwright is missing, and `4` when
  a run errors, is cancelled, or is still going when the wait ends.
- Detect a runner that died: `wait` and the next `run` mark its run `error` with
  `TC_E_RUNNER_DIED` and free the project lock. Report a Playwright run that
  exits non-zero without any failed test as `TC_E_PLAYWRIGHT_CRASH`.
- Write run state, the `latest` pointer, and the run lock atomically.
- Escape file paths when selecting tests for a group re-run, so Windows paths
  and paths with regex characters select the right tests.
