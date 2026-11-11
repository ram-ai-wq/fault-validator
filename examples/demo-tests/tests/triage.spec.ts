import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('passing check @demo', () => {
  expect(2 + 2).toBe(4);
});

test('wrong expectation @demo @bug', () => {
  expect(0).toBe(10);
});

test('network unavailable @demo @network', () => {
  throw new Error(
    'page.goto: net::ERR_CONNECTION_REFUSED at https://localhost/login',
  );
});

test('missing locator @demo @locator', () => {
  throw new Error(
    "TimeoutError: locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Save' })",
  );
});

test('one-time failure @demo @flaky', () => {
  const marker = join(process.env.TC_RUN_DIR ?? '.', 'flaky.marker');
  if (!existsSync(marker)) {
    writeFileSync(marker, 'retried');
    throw new Error('backend temporarily unavailable');
  }
});

test('non-repeatable scenario @demo @no-rerun', () => {
  throw new Error('record already exists');
});

test.fail('unexpected pass @demo @test-issue', () => {
  expect(true).toBe(true);
});

test('browser and worker runtime @runtime', async ({ page }) => {
  const runtime = process.versions.bun ? 'bun' : 'node';
  expect(runtime).toBe(process.env.DEMO_EXPECT_JS_RUNTIME);
  await page.setContent('<button>Ready</button>');
  await expect(page.getByRole('button', { name: 'Ready' })).toBeVisible();
});
