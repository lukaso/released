// Guards the branch-preview environment wired for issue #70. A per-PR preview
// deploy must stay ISOLATED from prod: a distinct Worker name (its own secret
// store — so a preview deploy can never touch prod creds, the #110 footgun) and
// NONE of the prod-only OUTBOUND bindings (the Anubis relay container, the prod
// analytics dataset). This test fails if someone re-adds one and silently
// un-isolates previews.
//
// It resolves the config with WRANGLER ITSELF (`unstable_readConfig`, already a
// devDependency of this package) rather than a hand-rolled TOML reader, so the
// assertions run against wrangler's real environment resolution — the same one
// the deploy uses. That closes the gap a header-only regex parser left open: a
// binding written as an inline array/table (`kv_namespaces = [ ... ]`,
// `durable_objects = { bindings = [ ... ] }`) resolves into the env just the
// same, and only wrangler catches every form.

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { unstable_readConfig } from 'wrangler';

const configPath = fileURLToPath(new URL('../wrangler.toml', import.meta.url));

// wrangler warns (via its logger) that top-level `durable_objects`/`containers`/
// `analytics_engine_datasets` are not inherited by `env.preview` — which is
// exactly the isolation we want, so quiet the noise for the test run.
process.env.WRANGLER_LOG = 'error';

function resolve(env?: string) {
  return unstable_readConfig({ config: configPath, ...(env ? { env } : {}) });
}

const prod = resolve();
const preview = resolve('preview');

describe('wrangler.toml branch-preview environment (issue #70)', () => {
  it('resolves a preview env with a name distinct from prod', () => {
    expect(prod.name).toBe('released-web');
    expect(preview.name).toBe('released-web-preview');
    // A distinct name means a distinct secret store: a preview deploy can never
    // read or overwrite prod's secrets (the #110 wrangler footgun).
    expect(preview.name).not.toBe(prod.name);
  });

  it('carries NONE of the prod-only outbound bindings into preview', () => {
    // These are the side-effecting bindings that could touch prod from a
    // preview: the Anubis relay CONTAINER (Cloudchamber) and the prod
    // `released_events` analytics dataset the maintaining loop reads back.
    // wrangler does not inherit binding tables into named envs, and preview
    // deliberately omits them, so they resolve empty here. Asserting on the
    // RESOLVED config (not the raw text) also catches inline-array/table forms.
    expect(preview.containers ?? []).toEqual([]);
    expect(preview.analytics_engine_datasets ?? []).toEqual([]);
    expect(preview.durable_objects?.bindings ?? []).toEqual([]);
  });

  it('is a real isolation difference — prod DOES declare those bindings', () => {
    // Proves the guard above is not vacuously green: the exact bindings preview
    // omits are present on prod, so a regression that copies one down would flip
    // this suite red.
    expect((prod.containers ?? []).length).toBeGreaterThan(0);
    expect((prod.analytics_engine_datasets ?? []).length).toBeGreaterThan(0);
    expect((prod.durable_objects?.bindings ?? []).map((b: { name: string }) => b.name)).toContain(
      'RELAY',
    );
  });

  it('disables the Anubis relay in preview (ANUBIS_HOSTS empty)', () => {
    // Belt-and-suspenders: even without the RELAY binding or RELAY_SECRET, an
    // empty ANUBIS_HOSTS empties the relay allowlist (relay.ts anubisHostsFromEnv
    // + makeRelayFetch), so blocked hosts degrade to the CLI-hint card instead of
    // hard-failing.
    expect(preview.vars?.ANUBIS_HOSTS).toBe('');
  });

  it('overrides migrations to empty so the prod DO migration does not inherit', () => {
    // `[[migrations]]` IS inheritable in wrangler (unlike binding tables), so an
    // un-overridden preview would inherit prod's `v1` GitlabRelay migration and,
    // on first upload, try to provision a Container-backed DO SQLite class with
    // no [[containers]] config — a dangling class at best, a failed upload at
    // worst. `[env.preview]` sets `migrations = []` to cut that; prod keeps its
    // real migration, so this is a genuine override, not a vacuous match.
    expect(preview.migrations ?? []).toEqual([]);
    expect((prod.migrations ?? []).length).toBeGreaterThan(0);
  });

  it('still exposes /version in preview (version_metadata redeclared)', () => {
    // version_metadata is a non-inheritable binding, so it must be repeated for
    // the liveness probe's /version check to report a real tag on the preview.
    expect(preview.version_metadata?.binding).toBe('CF_VERSION_METADATA');
  });
});
