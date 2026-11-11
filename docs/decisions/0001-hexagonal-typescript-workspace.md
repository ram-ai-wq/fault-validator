# ADR 0001: TypeScript workspace with a pure core

- Status: accepted
- Date: 2026-11-11

## Context

The product must run Playwright Test locally, classify failures deterministically,
and expose a compact interface to command-line and MCP clients. Domain logic
must remain testable without file-system, process, network, or environment I/O.

## Decision

Use a strict ESM TypeScript workspace managed by Bun 1.4.4, with a committed
`bun.lock` and workspace declarations in `package.json`. Keep domain logic in a
pure core package and implement the CLI, runner, reporter, container runtime,
and MCP server as adapters in the CLI package.

Retain Node.js-compatible build output and Vitest. The launcher preserves its
JavaScript runtime (Bun or Node.js) through subprocesses and container execution.
Container dependency installation follows the tested project's package manager,
independently of the runtime used to execute its tests.

## Consequences

The core can be unit-tested without file-system, process, or network access,
and the CLI bundles it into a single publishable package. The npm scope
`@scope` is a placeholder until the maintainer chooses a real one.
