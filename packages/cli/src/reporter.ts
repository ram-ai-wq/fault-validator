import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type TestRef = {
  id: string;
  titlePath: string[];
  file: string;
  line: number;
  project: string;
  tags: string[];
  expectedStatus: string;
};

type FailureEvent = {
  test: TestRef;
  errors: Array<{ message: string; stack?: string }>;
  status: string;
  attachments: Array<{ name: string; path: string }>;
};

type ReporterTest = {
  id: string;
  titlePath(): string[];
  location: { file: string; line: number };
  parent: { project(): { name: string } | undefined };
  tags?: string[];
  expectedStatus: string;
};

type ReporterResult = {
  status: string;
  errors?: Array<{ message?: string; stack?: string }>;
  error?: { message?: string; stack?: string };
  attachments?: Array<{ name: string; path?: string }>;
};

type ReporterSuite = { allTests(): ReporterTest[] };

export default class TestContainerReporter {
  private readonly outputFile = process.env.TC_EVENTS_FILE;
  private readonly mode = process.env.TC_MODE ?? 'run';
  private readonly rerunIds = new Set(
    (process.env.TC_RERUN_IDS ?? '').split(',').filter(Boolean),
  );
  private selected = 0;
  private passed = 0;
  private failed = 0;
  private skipped = 0;
  private readonly failures: FailureEvent[] = [];
  private readonly rerunPassed: TestRef[] = [];

  printsToStdio(): boolean {
    return false;
  }

  onBegin(_config: unknown, suite: ReporterSuite): void {
    this.selected = suite.allTests().length;
  }

  onTestEnd(test: ReporterTest, result: ReporterResult): void {
    const ref: TestRef = {
      id: test.id,
      // titlePath() starts with the root suite, project, and file entries.
      titlePath: test.titlePath().slice(3),
      file: test.location.file,
      line: test.location.line,
      project: test.parent.project()?.name ?? '',
      tags: test.tags ?? [],
      expectedStatus: test.expectedStatus,
    };
    const expected = test.expectedStatus;
    const actual = result.status;
    if (expected === 'skipped' || actual === 'skipped') {
      this.skipped += 1;
      return;
    }
    if (actual === expected) {
      this.passed += 1;
      if (this.mode === 'rerun' && this.rerunIds.has(ref.id))
        this.rerunPassed.push(ref);
      return;
    }
    this.failed += 1;
    const rawErrors = result.errors?.length
      ? result.errors
      : result.error
        ? [result.error]
        : [];
    this.failures.push({
      test: ref,
      errors: rawErrors.length
        ? rawErrors.map((error) => ({
            message:
              error.message ?? error.stack ?? 'Unknown Playwright failure',
            stack: error.stack,
          }))
        : [
            {
              message:
                expected === 'failed' && actual === 'passed'
                  ? 'Expected to fail, but passed'
                  : 'Unknown Playwright failure',
            },
          ],
      status: actual,
      attachments: (result.attachments ?? [])
        .filter((attachment): attachment is { name: string; path: string } =>
          Boolean(attachment.path),
        )
        .map(({ name, path }) => ({ name, path })),
    });
  }

  onEnd(): void {
    if (!this.outputFile) return;
    mkdirSync(dirname(this.outputFile), { recursive: true });
    writeFileSync(
      this.outputFile,
      JSON.stringify({
        selected: this.selected,
        passed: this.passed,
        failed: this.failed,
        skipped: this.skipped,
        failures: this.failures,
        rerunPassed: this.rerunPassed,
      }),
    );
  }
}
