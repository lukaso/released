// CLI cache: JSON files at ~/.cache/released/{sha256-hex}.json with 30-min TTL.
// Uses the same cacheKey() as web/web-og so all three packages share semantics.

import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CacheStore } from '@released/core';

type Envelope<T> = { value: T; expiresAt: number };

export type FileCacheOpts = {
  /** Directory for cache files. Default: ~/.cache/released */
  dir?: string;
  /** LRU cap on entry count. Default: 1000. */
  maxEntries?: number;
};

export function makeFileCache(
  opts: FileCacheOpts = {},
): CacheStore & { clear(): Promise<void>; dir: string } {
  const dir = opts.dir ?? join(homedir(), '.cache', 'released');
  const maxEntries = opts.maxEntries ?? 1000;

  async function ensureDir(): Promise<void> {
    await mkdir(dir, { recursive: true });
  }

  function file(key: string): string {
    return join(dir, `${key}.json`);
  }

  async function get<T>(key: string): Promise<T | null> {
    try {
      const raw = await readFile(file(key), 'utf8');
      const env = JSON.parse(raw) as Envelope<T>;
      if (env.expiresAt < Date.now()) {
        // Expired — fire-and-forget delete.
        unlink(file(key)).catch(() => undefined);
        return null;
      }
      return env.value;
    } catch {
      return null;
    }
  }

  async function put<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await ensureDir();
    const env: Envelope<T> = { value, expiresAt: Date.now() + ttlSeconds * 1000 };
    // Atomic write: write to tmp then rename. Safe for concurrent CLIs.
    const tmp = `${file(key)}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    await writeFile(tmp, JSON.stringify(env), 'utf8');
    await rename(tmp, file(key));
    // Best-effort LRU eviction.
    await evictIfNeeded();
  }

  async function rename(from: string, to: string): Promise<void> {
    const { rename: fsRename } = await import('node:fs/promises');
    await fsRename(from, to);
  }

  async function evictIfNeeded(): Promise<void> {
    try {
      const names = await readdir(dir);
      const jsonFiles = names.filter((n) => n.endsWith('.json'));
      if (jsonFiles.length <= maxEntries) return;
      const stats = await Promise.all(
        jsonFiles.map(async (n) => ({ n, mtime: (await stat(join(dir, n))).mtimeMs })),
      );
      stats.sort((a, b) => a.mtime - b.mtime);
      const toDelete = stats.slice(0, stats.length - maxEntries);
      await Promise.all(toDelete.map(({ n }) => unlink(join(dir, n)).catch(() => undefined)));
    } catch {
      // best-effort
    }
  }

  async function clear(): Promise<void> {
    try {
      const names = await readdir(dir);
      await Promise.all(names.map((n) => unlink(join(dir, n)).catch(() => undefined)));
    } catch {
      // best-effort
    }
  }

  return { get, put, clear, dir };
}
