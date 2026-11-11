import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node22',
    outDir: 'dist',
    clean: true,
    noExternal: ['@scope/core'],
    external: ['yaml'],
  },
  {
    entry: ['src/runner.ts', 'src/reporter.ts'],
    format: ['cjs'],
    target: 'node22',
    outDir: 'dist',
    outExtension: () => ({ js: '.cjs' }),
    clean: false,
    noExternal: ['@scope/core'],
  },
]);
