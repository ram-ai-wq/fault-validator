import { describe, expect, it, vi } from 'vitest';
import { renameWithRetry } from '../src/files.js';

function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('renameWithRetry', () => {
  it('retries while the target is locked', () => {
    const rename = vi
      .fn()
      .mockImplementationOnce(() => {
        throw failure('EPERM');
      })
      .mockImplementationOnce(() => {
        throw failure('EBUSY');
      })
      .mockImplementation(() => undefined);
    const wait = vi.fn();

    renameWithRetry('a', 'b', rename, wait);

    expect(rename).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('fails fast on other errors and gives up on a persistent lock', () => {
    const missing = vi.fn(() => {
      throw failure('ENOENT');
    });
    expect(() => renameWithRetry('a', 'b', missing, vi.fn())).toThrow('ENOENT');
    expect(missing).toHaveBeenCalledTimes(1);

    const locked = vi.fn(() => {
      throw failure('EPERM');
    });
    expect(() => renameWithRetry('a', 'b', locked, vi.fn())).toThrow('EPERM');
    expect(locked).toHaveBeenCalledTimes(40);
  });
});
