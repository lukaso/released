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
    // The first test in each file pays a one-time cost: a dynamic import of the
    // whole Worker (`src/index.js`) plus its esbuild transform. Under a loaded
    // `pnpm -r test` (all packages in parallel) that can exceed vitest's 5s
    // default per-test budget and flake — most visibly event.test.ts's first
    // beacon test. CI's less-loaded runners stay under 5s, so this only bit the
    // local pre-push gate. 15s gives ample headroom without masking a real hang.
    testTimeout: 15_000,
  },
});
