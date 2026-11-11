import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['examples/demo-tests/**', '**/node_modules/**', '**/dist/**'],
  },
});
