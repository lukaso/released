import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'hono/jsx',
  },
  test: {
    // Plain-Node tests only. The real-render tests (*.render.test.ts) run under
    // the Workers pool (vitest.workers.config.ts) because workers-og's wasm only
    // loads through workerd — exclude them here so this config never tries.
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'test/**/*.render.test.ts'],
  },
});
