import { renameSync, rmSync, writeFileSync } from 'node:fs';

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);
const MAX_ATTEMPTS = 40;

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// On Windows a rename fails while another process, such as a polling client or
// a virus scanner, has the target open. Retry briefly before giving up.
export function renameWithRetry(
  from: string,
  to: string,
  rename: (from: string, to: string) => void = renameSync,
  wait: (ms: number) => void = pause,
): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= MAX_ATTEMPTS || !code || !RETRYABLE.has(code)) throw error;
      wait(Math.min(10 * attempt, 100));
    }
  }
}

export function writeTextAtomic(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content);
  try {
    renameWithRetry(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeTextAtomic(path, JSON.stringify(value, null, 2));
}
