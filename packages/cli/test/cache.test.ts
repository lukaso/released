import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFileCache } from '../src/cache.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'released-cache-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('makeFileCache', () => {
  it('round-trips a value', async () => {
    const cache = makeFileCache({ dir });
    await cache.put('k1', { hello: 'world' }, 60);
    expect(await cache.get('k1')).toEqual({ hello: 'world' });
  });

  it('returns null for missing keys', async () => {
    const cache = makeFileCache({ dir });
    expect(await cache.get('nope')).toBeNull();
  });

  it('returns null for expired entries (TTL=0)', async () => {
    const cache = makeFileCache({ dir });
    await cache.put('k', 1, 0);
    // Wait 5ms to ensure we're past the boundary.
    await new Promise((r) => setTimeout(r, 5));
    expect(await cache.get('k')).toBeNull();
  });

  it('evicts oldest entries when over the cap', async () => {
    const cache = makeFileCache({ dir, maxEntries: 3 });
    await cache.put('a', 1, 60);
    await cache.put('b', 2, 60);
    await cache.put('c', 3, 60);
    await cache.put('d', 4, 60);
    await cache.put('e', 5, 60);
    // The earliest entries (a, b) should be evicted.
    expect(await cache.get('a')).toBeNull();
    expect(await cache.get('e')).toBe(5);
  });
});
