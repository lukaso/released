import { describe, expect, it } from 'vitest';
import { cacheKey } from '../src/cache.js';

describe('cacheKey — stability + isolation', () => {
  it('produces a 64-char hex SHA-256 digest', async () => {
    const k = await cacheKey('res', 'github.com/facebook/react', 'abc123');
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same inputs', async () => {
    const a = await cacheKey('res', 'github.com/facebook/react', 'abc123');
    const b = await cacheKey('res', 'github.com/facebook/react', 'abc123');
    expect(a).toBe(b);
  });

  it('differs across different kinds', async () => {
    const a = await cacheKey('res', 'github.com/facebook/react', 'abc123');
    const b = await cacheKey('tags', 'github.com/facebook/react', 'abc123');
    expect(a).not.toBe(b);
  });

  it('differs across different parts', async () => {
    const a = await cacheKey('cmp', 'github.com/facebook/react', 'tagSha1', 'commitSha');
    const b = await cacheKey('cmp', 'github.com/facebook/react', 'tagSha2', 'commitSha');
    expect(a).not.toBe(b);
  });

  it('SAME projectPath on DIFFERENT hosts produces DIFFERENT keys (federation)', async () => {
    // Critical: github.com/foo/bar and gitlab.com/foo/bar must NOT collide.
    // Pre-federation this would have, because the key was just "foo/bar".
    const gh = await cacheKey('res', 'github.com/foo/bar', 'sha:abc');
    const gl = await cacheKey('res', 'gitlab.com/foo/bar', 'sha:abc');
    expect(gh).not.toBe(gl);
  });

  it('html/og keys include OG template version (changing it invalidates them)', async () => {
    const resK = await cacheKey('res', 'github.com/facebook/react', 'abc');
    const htmlK = await cacheKey('html', 'github.com/facebook/react', 'abc');
    const ogK = await cacheKey('og', 'github.com/facebook/react', 'abc');
    expect(resK).not.toBe(htmlK);
    expect(htmlK).not.toBe(ogK);
  });

  // Snapshot for stability — if these change in a future edit, cross-Worker
  // cache sharing breaks silently. Caught at CI time. CACHE_NS=v2 here (federation bump).
  it('SNAPSHOT — known fixed keys', async () => {
    expect(await cacheKey('res', 'github.com/facebook/react', 'abc')).toMatchInlineSnapshot(
      `"c7be19622a14d1b0f09b3a61640262142980e867e3e5bb7b9a284359d38430a1"`,
    );
    expect(await cacheKey('tags', 'github.com/facebook/react')).toMatchInlineSnapshot(
      `"603b283af3187f3364b35f79fec28f772c93a7ba9102a4cca55c9bb77ec22f2c"`,
    );
  });
});
