# Contributing

## Development

Use Bun 1.4.4 and Node.js 22 or newer. Run `bun install --frozen-lockfile`,
then `bun run check` and `bun run build` before submitting a change.
Commit `bun.lock` with dependency changes. `bun run test` uses Vitest;
`bun test` is a different runner and is not used here.

The CLI supports both `bun run cli` and `node packages/cli/dist/index.js`.
CI exercises both runtimes. For a local browser smoke test, install Chromium
with `bun run --cwd examples/demo-tests playwright install chromium`, then run:

```sh
bun run cli run --tags @runtime --env DEMO_EXPECT_JS_RUNTIME=bun --runtime native --project-root examples/demo-tests --wait
```

## Changes

Use Conventional Commits. Add focused tests for behavior changes. For new
classification rules, include anonymized positive and negative corpus samples.
Record material architecture decisions in `docs/decisions/`.
