import { describe, expect, it } from 'vitest';
import { cacheKey } from '../src/cache.js';

describe('cacheKey — stability + isolation', () => {
  it('produces a 64-char hex SHA-256 digest', async () => {
    const k = await cacheKey('res', 'facebook/react', 'abc123');
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same inputs', async () => {
    const a = await cacheKey('res', 'facebook/react', 'abc123');
    const b = await cacheKey('res', 'facebook/react', 'abc123');
    expect(a).toBe(b);
  });

  it('differs across different kinds', async () => {
    const a = await cacheKey('res', 'facebook/react', 'abc123');
    const b = await cacheKey('tags', 'facebook/react', 'abc123');
    expect(a).not.toBe(b);
  });

  it('differs across different parts', async () => {
    const a = await cacheKey('cmp', 'facebook/react', 'tagSha1', 'commitSha');
    const b = await cacheKey('cmp', 'facebook/react', 'tagSha2', 'commitSha');
    expect(a).not.toBe(b);
  });

  it('html/og keys include OG template version (changing it invalidates them)', async () => {
    // Two different keys for the same data — the html/og namespace specifically
    // includes OG_TEMPLATE_VERSION while res does not.
    const resK = await cacheKey('res', 'facebook/react', 'abc');
    const htmlK = await cacheKey('html', 'facebook/react', 'abc');
    const ogK = await cacheKey('og', 'facebook/react', 'abc');
    expect(resK).not.toBe(htmlK);
    expect(htmlK).not.toBe(ogK);
  });

  // Snapshot for stability — if these change in a future edit, cross-Worker
  // cache sharing breaks silently. Caught at CI time.
  it('SNAPSHOT — known fixed keys', async () => {
    expect(await cacheKey('res', 'facebook/react', 'abc')).toMatchInlineSnapshot(
      `"051da50c3ba90593d2a8b02034168ec11430d745d56158cabe30bb6ef903033b"`,
    );
    expect(await cacheKey('tags', 'facebook/react')).toMatchInlineSnapshot(
      `"1935cbe0599b6eedca7e0802760e949f7b26e45316ff4cd2604a4ae7e52cece4"`,
    );
  });
});
