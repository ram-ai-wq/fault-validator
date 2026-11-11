# Security Policy

Do not report security vulnerabilities in public issues. Use GitHub's private
vulnerability reporting for this repository (Security tab, then "Report a
vulnerability") with a description, reproduction steps, and impact. Do not
include secrets or sensitive user data in reports.

The project is local-first and does not intentionally send test artifacts or
telemetry to external services.

## Data handling

- Secrets reach tests only through `env.passthrough`. Run state stores
  variable names, never values.
- Redaction of the text artifacts in a run folder is best effort. It works by
  variable name and by pattern, so it can miss a secret in an ordinary-looking
  variable. A value shorter than six characters is redacted only inside
  recognizable patterns such as headers, URLs, and `key=value` pairs, never
  everywhere it appears.
- Playwright trace archives are not redacted. Treat `.test-container/` as
  sensitive, and do not attach it to issues or commit it.
  The folder ignores itself in Git.

## Trust boundaries

- A run executes the tested project's Playwright configuration and test code.
  Use `test-container` only on projects you trust, as you would
  `playwright test`.
- The `docker` runtime provides reproducible browsers and libraries, not
  isolation. The project folder is mounted read-write, the container runs as
  the image's default user, `--ipc=host` is on by default, and
  `docker.extraArgs` from the project configuration reaches the container
  engine unchanged. Test selection runs on the host in every runtime.
- The MCP server serves the one project folder chosen by whoever starts it
  (`mcp --project-root`, or the current directory). Clients cannot pick another
  folder. A client that can call `start_run` or `rerun_group` can run that
  project's tests, so connect only clients you trust with that ability.
- `--env` and the MCP `env` fields reject secret-looking names and names that
  steer how the tools start, such as `TC_*`, `PATH`, `NODE_OPTIONS`, `LD_*`, and
  `DOCKER_*`. The env file and `env.passthrough` belong to the project's own
  configuration and are not filtered that way.
