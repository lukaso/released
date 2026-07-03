// Guards the branch-preview environment wired for issue #70. A per-PR preview
// deploy must stay ISOLATED from prod: a distinct Worker name (its own secret
// store — so a preview deploy can never touch prod creds, the #110 footgun) and
// NO prod-only outbound bindings (the Anubis relay container / durable object,
// the prod analytics dataset). Bindings are non-inheritable in wrangler, so the
// isolation is expressed by *omitting* those tables from `[env.preview]`; this
// test fails if someone re-adds one and silently un-isolates previews.
//
// Parsed with a tiny purpose-built TOML reader (no parser dep in the tree): it
// only needs table headers (`[a.b]`, `[[a.b]]`) and `key = "value"` pairs, which
// is all this config uses.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const wranglerToml = readFileSync(
  fileURLToPath(new URL('../wrangler.toml', import.meta.url)),
  'utf8',
);

/**
 * Minimal TOML reader: returns the set of every table/array-of-table header
 * seen, plus a map of `section → { key: value }` for simple string/quoted
 * values. Root-level keys live under the '' section. Array-of-tables headers
 * (`[[x]]`) are recorded in the header set with their bare name.
 */
function readToml(src: string) {
  const headers = new Set<string>();
  const sections = new Map<string, Record<string, string>>();
  let current = '';
  sections.set('', {});
  for (const rawLine of src.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const header = line.match(/^\[\[?(.+?)\]?\]$/);
    if (header) {
      const name = (header[1] ?? '').trim();
      headers.add(name);
      current = name;
      if (!sections.has(name)) sections.set(name, {});
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (kv) {
      const key = (kv[1] ?? '').trim();
      const value = (kv[2] ?? '').trim().replace(/^["']|["']$/g, '');
      const bag = sections.get(current);
      if (bag) bag[key] = value;
    }
  }
  return { headers, sections };
}

const { headers, sections } = readToml(wranglerToml);

describe('wrangler.toml branch-preview environment (issue #70)', () => {
  it('declares a preview env with a name distinct from prod', () => {
    const prodName = sections.get('')?.name;
    const previewName = sections.get('env.preview')?.name;
    expect(prodName).toBe('released-web');
    expect(previewName).toBe('released-web-preview');
    expect(previewName).not.toBe(prodName);
  });

  it('disables the Anubis relay in preview (ANUBIS_HOSTS empty)', () => {
    // Empty string disables the relay (see relay.ts anubisHostsFromEnv) — a
    // belt-and-suspenders on top of the omitted RELAY binding below.
    expect(sections.get('env.preview.vars')?.ANUBIS_HOSTS).toBe('');
  });

  it('omits every prod-only outbound binding from the preview env', () => {
    // Non-inheritable bindings absent under env.preview => the preview cannot
    // fire prod side effects: no relay container/DO, no writes to the prod
    // `released_events` analytics dataset the maintaining loop reads back.
    for (const banned of [
      'env.preview.containers',
      'env.preview.durable_objects.bindings',
      'env.preview.durable_objects',
      'env.preview.analytics_engine_datasets',
      'env.preview.migrations',
    ]) {
      expect(headers.has(banned)).toBe(false);
    }
  });

  it('still exposes /version in preview (version_metadata redeclared)', () => {
    // version_metadata is a non-inheritable binding, so it must be repeated for
    // the liveness probe's /version check to report a real tag on the preview.
    expect(sections.get('env.preview.version_metadata')?.binding).toBe('CF_VERSION_METADATA');
  });
});
