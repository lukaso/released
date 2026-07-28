// Runs ONLY the real-render tests (*.render.test.ts) under the Workers runtime
// (workerd via miniflare). workers-og's wasm (satori yoga + resvg) loads through
// workerd's module graph, so it renders a real PNG here — and a blank/throwing
// render (the #56 class) fails the byte/magic assertions. The plain-Node routing
// tests keep their own config (vitest.config.ts); this pool is separate so it
// never touches them.
//
// v4 API: @cloudflare/vitest-pool-workers exposes a `cloudflareTest` vitest
// plugin (replacing the old defineWorkersProject + poolOptions.workers). See the
// package's vitest-v3-to-v4 codemod.
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'hono/jsx',
  },
  plugins: [
    cloudflareTest({
      // Test-only config (no Service Binding) — see wrangler.test.toml. wrangler
      // bundles workers-og's wasm natively for workerd from this config.
      wrangler: { configPath: './wrangler.test.toml' },
    }),
  ],
  test: {
    include: ['test/**/*.render.test.ts'],
  },
});
