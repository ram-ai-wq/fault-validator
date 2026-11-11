# Classification

Classification is deterministic and local. For a given configuration, the same
failure always produces the same class, reason, and confidence. No model or
network call is involved.

## Pipeline

1. **Normalize.** The error text is cleaned (ANSI codes, line endings, length)
   and assigned a kind such as `locator-timeout`, `locator-strict`,
   `expect-value`, `navigation-network`, or `hook-failure`.
2. **Sign.** The signature is the first 10 hex characters of a SHA-1 over the
   error kind, the first error line with volatile parts removed (project path,
   ids, timestamps, durations, numbers, query strings), the locator, the
   matcher, and the first stack frame outside spec files.
3. **Classify.** The first matching step in the table below decides the class,
   reason, and confidence.
4. **Group.** Failures that share a signature, class, and reason form a group.
   Groups are ordered by size, then class priority (`BUG`, `LOCATOR`,
   `TEST_ISSUE`, `INCONCLUSIVE`, `ENVIRONMENT`, `KNOWN_ISSUE`, `TRANSIENT`),
   then signature, and are numbered `G1`, `G2`, and so on.

## Classes

| Class          | Meaning                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `TRANSIENT`    | Failed first, then passed on a re-run.                                                             |
| `ENVIRONMENT`  | A network, browser, or overlay problem outside the behavior under test.                            |
| `LOCATOR`      | A locator no longer matches, or matches more than one element.                                     |
| `TEST_ISSUE`   | The test itself is at fault: script errors, hook failures, or a test expected to fail that passed. |
| `BUG`          | An assertion on a value or state failed.                                                           |
| `KNOWN_ISSUE`  | The failure matches an entry in your known-issues file.                                            |
| `INCONCLUSIVE` | No step was confident enough to decide.                                                            |

## Order of evaluation

| Step | Condition                                                                         | Class, reason, confidence                                                                      |
| ---- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1    | A later attempt passed                                                            | `TRANSIENT`, `transient.passed-on-rerun`, 0.95                                                 |
| 2    | A known issue matches                                                             | `KNOWN_ISSUE`, `known.<id>`, 0.95                                                              |
| 3    | A custom rule matches (first match in file order wins)                            | The rule's class, reason, and confidence                                                       |
| 4    | `net::ERR_*`, `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, `ENOTFOUND` | `ENVIRONMENT`, `env.network`, 0.90                                                             |
| 5    | A browser executable is missing                                                   | `ENVIRONMENT`, `env.browser-missing`, 0.95                                                     |
| 6    | A `test.fail()` test passed                                                       | `TEST_ISSUE`, `test.unexpected-pass`, 0.90                                                     |
| 7    | `TypeError`, `ReferenceError`, `SyntaxError`, or `RangeError`                     | `TEST_ISSUE`, `test.code-error`, 0.80                                                          |
| 8    | Strict mode violation (several elements match)                                    | `LOCATOR`, `locator.ambiguous`, 0.90                                                           |
| 9    | Another element intercepts pointer events                                         | `ENVIRONMENT`, `env.loading-overlay`, 0.75                                                     |
| 10   | Locator error, but the locator resolved to an element                             | `INCONCLUSIVE`, `unknown`, 0.45                                                                |
| 11   | Locator error with a unique replacement above the threshold                       | `LOCATOR`, `locator.renamed`, the suggestion score                                             |
| 12   | Locator error without a unique replacement                                        | `INCONCLUSIVE`, `locator.missing`, 0.45 (or `BUG` with `classification.locatorMissingAs: BUG`) |
| 13   | Value or generic assertion failure                                                | `BUG`, `bug.assertion-value`, 0.65                                                             |
| 14   | `beforeAll`, `beforeEach`, `afterAll`, or `afterEach` failure                     | `TEST_ISSUE`, `test.hook-failure`, 0.55                                                        |
| 15   | Anything else                                                                     | `INCONCLUSIVE`, `unknown`, 0.25                                                                |

If the attempts of one test fail with different signatures, the failure is
unstable: its confidence is capped at 0.5, and a `LOCATOR` result becomes
`INCONCLUSIVE` with the reason `unstable.signature-changed`.

## Custom rules

Add rules to `test-container.rules.yml` in the project root. Rules run after
known issues and before the built-in steps. `init --write` creates an empty
file.

```yaml
version: 1
rules:
  - id: team.session-expired
    class: ENVIRONMENT
    reason: env.session-expired
    confidence: 0.85
    explain: "Session expired: {{match}}"
    when:
      any:
        - message: /session (has )?expired/i
        - firstLine: /redirected to \/login/i
      not:
        - tags: /@no-session/
```

Each entry under `all`, `any`, and `not` is a condition. A condition matches
when every field in it matches. The fields are `message`, `firstLine`,
`errorKind`, `matcher`, `locator`, `file`, `title`, `project`, `tags` (joined by
spaces), and `topFrameFile`. A value is an exact string, a `/regex/flags`
string, or a list of exact strings. A rule matches when all of its `all`
conditions match, at least one `any` condition matches, and no `not` condition
matches. `{{match}}` in `explain` is replaced by the first error line, and the
explanation is cut to 140 characters in reports.

## Known issues

List failures you already track in `test-container.known-issues.yml`.

```yaml
version: 1
issues:
  - id: BUG-1234
    title: Report export times out on QA
    link: https://example.com/issues/1234
    env: [qa]
    match:
      pathContains: reports/
      titleContains: export
      errorMatches: /Timeout \d+ms exceeded/
```

An issue applies when every field under `match` matches. `pathContains` and
`titleContains` are substring checks (`titleContains` ignores case), and
`errorMatches` is a regular expression tested against the first error line.
`env` limits the issue to runs whose environment variable
(`classification.envVar`, default `ENV`) has one of the listed values.

## Locator suggestions

For locator failures, the runner reads the page's ARIA snapshot from
Playwright's `error-context.md` and scores elements with the same role by name
similarity. A suggestion is a `getByRole(..., { exact: true })` expression with
a score. It becomes a `LOCATOR` classification only when it is unique in the
snapshot and its score reaches `classification.locatorThreshold` (default
0.8). Suggestions are reported, never applied.
