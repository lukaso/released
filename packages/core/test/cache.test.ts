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
  // cache sharing breaks silently. Caught at CI time. CACHE_NS=v4 here (bumped to
  // flush stale "not yet released" answers after the containing-tag pagination fix).
  it('SNAPSHOT — known fixed keys', async () => {
    expect(await cacheKey('res', 'github.com/facebook/react', 'abc')).toMatchInlineSnapshot(
      `"64dd27bd029047e70855fd1031f42e3e840deb08c05c4228f536e367fd2b9b1d"`,
    );
    expect(await cacheKey('tags', 'github.com/facebook/react')).toMatchInlineSnapshot(
      `"c9bdf968d54d62051d817710535223ad5b7a901480b56aaf5113dcc0b391526e"`,
    );
  });
});
