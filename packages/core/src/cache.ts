// Shared cache-key generation + the CacheStore interface.
//
// All three packages (cli, web, web-og) import `cacheKey` from here. A test
// asserts key stability (snapshot) so an accidental change that would silently
// break cross-Worker cache sharing fails CI.

import { CACHE_NS, OG_TEMPLATE_VERSION } from './types.js';

/** Categories of cache entry. Mirrors the plan's "Caching strategy" section. */
export type CacheKind = 'res' | 'tags' | 'cmp' | 'rn' | 'html' | 'og';

/** Deterministic SHA-256 hex over the canonical key string for a (kind, parts) tuple.
 *  Same input → same output, regardless of platform (Node/Workers both expose SubtleCrypto). */
export async function cacheKey(kind: CacheKind, ...parts: readonly string[]): Promise<string> {
  const segments = [CACHE_NS, kind];
  // The 'html' and 'og' kinds carry the OG template version so layout/wording
  // changes invalidate independently from data-shape changes.
  if (kind === 'html' || kind === 'og') segments.push(OG_TEMPLATE_VERSION);
  segments.push(...parts);
  return sha256Hex(segments.join('|'));
}

/** Generic store interface implemented by cli (filesystem JSON) and web
 *  (Cloudflare Cache API wrapper). Both write/read the SAME keys. */
export type CacheStore = {
  get<T>(key: string): Promise<T | null>;
  put<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
};

async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}
