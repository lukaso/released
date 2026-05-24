// ogBaseUrl / publicBaseUrl base-URL resolution. The load-bearing case is the
// `wrangler dev` IP-host trap: `og.127.0.0.1` is an invalid URL (the trailing
// numeric label makes URL parsing attempt and fail an IPv4 parse), which used to
// 500 every Layout-rendered page when the worker was hit via the IP form.

import { describe, expect, it } from 'vitest';
import { ogBaseUrl, publicBaseUrl } from '../src/env.js';

describe('ogBaseUrl', () => {
  it('uses the OG_BASE_URL env var when set (trailing slash stripped)', () => {
    const req = new Request('https://released.example/');
    expect(ogBaseUrl({ OG_BASE_URL: 'https://og.released.example/' }, req)).toBe(
      'https://og.released.example',
    );
  });

  it('derives the og. subdomain for a real domain host', () => {
    const req = new Request('https://released.blabberate.com/h/x/r/y/c/abc1234');
    expect(ogBaseUrl(undefined, req)).toBe('https://og.released.blabberate.com');
  });

  it('keeps the og. prefix for localhost-by-name (a valid host on any port)', () => {
    const req = new Request('http://localhost:8787/');
    expect(ogBaseUrl(undefined, req)).toBe('http://og.localhost:8787');
  });

  it('falls back to the origin for an IP host (og.<ip> is an invalid URL)', () => {
    const req = new Request('http://127.0.0.1:8799/h/x/r/y/c/abc1234');
    const result = ogBaseUrl(undefined, req);
    // Must be a VALID url (the bug: og.127.0.0.1 threw) and must not 500 a page.
    expect(() => new URL(result)).not.toThrow();
    expect(result).toBe('http://127.0.0.1:8799');
    expect(result).not.toContain('og.127.0.0.1');
  });
});

describe('publicBaseUrl', () => {
  it('uses PUBLIC_BASE_URL when set (trailing slash stripped)', () => {
    const req = new Request('http://127.0.0.1:8799/');
    expect(publicBaseUrl({ PUBLIC_BASE_URL: 'https://released.blabberate.com/' }, req)).toBe(
      'https://released.blabberate.com',
    );
  });

  it('defaults to the request origin', () => {
    const req = new Request('http://127.0.0.1:8799/h/x/r/y/c/abc1234');
    expect(publicBaseUrl(undefined, req)).toBe('http://127.0.0.1:8799');
  });
});
