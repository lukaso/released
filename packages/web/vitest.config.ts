import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'hono/jsx',
  },
  resolve: {
    alias: {
      // @cloudflare/containers imports DurableObject/WorkerEntrypoint from the
      // workerd-only `cloudflare:workers` module. Stub it so the app's module
      // graph loads under Node (vitest). Real behaviour is exercised on-edge.
      'cloudflare:workers': fileURLToPath(
        new URL('./test/stubs/cloudflare-workers.ts', import.meta.url),
      ),
    },
  },
  test: {
    // Worker-side TS tests, plus the container relay's plain-Node .mjs tests
    // (the container is a separate runtime, kept out of the TS build).
    include: ['test/**/*.test.ts', 'container/**/*.test.mjs'],
  },
});
