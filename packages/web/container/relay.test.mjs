import { describe, expect, it } from 'vitest';
import { handleRelay, parseAllowedHosts } from './relay.mjs';

const ALLOWED = parseAllowedHosts('gitlab.freedesktop.org, gitlab.gnome.org');
const SECRET = 's3cr3t';

/** A fake upstream fetch that records the call and returns a canned JSON body. */
function fakeFetch(record, { status = 200, headers = {}, body = '{"ok":true}' } = {}) {
  return async (url, init) => {
    record.url = url;
    record.init = init;
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  };
}

describe('handleRelay — auth', () => {
  it('rejects with 403 when the secret is missing', async () => {
    const r = await handleRelay(
      { headers: { 'x-relay-target': 'https://gitlab.freedesktop.org/api/v4/x' } },
      { expectedSecret: SECRET, allowedHosts: ALLOWED },
    );
    expect(r.status).toBe(403);
  });

  it('rejects with 403 when the secret mismatches', async () => {
    const r = await handleRelay(
      {
        headers: {
          'x-relay-secret': 'wrong',
          'x-relay-target': 'https://gitlab.freedesktop.org/x',
        },
      },
      { expectedSecret: SECRET, allowedHosts: ALLOWED },
    );
    expect(r.status).toBe(403);
  });

  it('rejects with 403 when no expectedSecret is configured (fail closed)', async () => {
    const r = await handleRelay(
      { headers: { 'x-relay-secret': '', 'x-relay-target': 'https://gitlab.freedesktop.org/x' } },
      { expectedSecret: undefined, allowedHosts: ALLOWED },
    );
    expect(r.status).toBe(403);
  });
});

describe('handleRelay — SSRF guard', () => {
  it('rejects a host that is not on the allowlist', async () => {
    const r = await handleRelay(
      { headers: { 'x-relay-secret': SECRET, 'x-relay-target': 'https://evil.example.com/api' } },
      { expectedSecret: SECRET, allowedHosts: ALLOWED },
    );
    expect(r.status).toBe(403);
  });

  it('rejects a non-https target', async () => {
    const r = await handleRelay(
      {
        headers: { 'x-relay-secret': SECRET, 'x-relay-target': 'http://gitlab.freedesktop.org/x' },
      },
      { expectedSecret: SECRET, allowedHosts: ALLOWED },
    );
    expect(r.status).toBe(403);
  });

  it('returns 400 on an unparseable target', async () => {
    const r = await handleRelay(
      { headers: { 'x-relay-secret': SECRET, 'x-relay-target': 'not a url' } },
      { expectedSecret: SECRET, allowedHosts: ALLOWED },
    );
    expect(r.status).toBe(400);
  });
});

describe('handleRelay — proxying', () => {
  it('forwards to the target and passes through status + body + content-type', async () => {
    const rec = {};
    const r = await handleRelay(
      {
        headers: {
          'x-relay-secret': SECRET,
          'x-relay-target': 'https://gitlab.freedesktop.org/api/v4/projects/1',
          'private-token': 'glpat-xyz',
        },
      },
      { expectedSecret: SECRET, allowedHosts: ALLOWED, fetchImpl: fakeFetch(rec) },
    );
    expect(rec.url).toBe('https://gitlab.freedesktop.org/api/v4/projects/1');
    expect(rec.init.headers['private-token']).toBe('glpat-xyz');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/json');
    expect(new TextDecoder().decode(r.body)).toBe('{"ok":true}');
  });

  it('strips relay-control headers before forwarding', async () => {
    const rec = {};
    await handleRelay(
      {
        headers: {
          'x-relay-secret': SECRET,
          'x-relay-target': 'https://gitlab.gnome.org/api/v4/x',
        },
      },
      { expectedSecret: SECRET, allowedHosts: ALLOWED, fetchImpl: fakeFetch(rec) },
    );
    expect(rec.init.headers['x-relay-secret']).toBeUndefined();
    expect(rec.init.headers['x-relay-target']).toBeUndefined();
  });

  it('replaces a Mozilla User-Agent (Anubis would challenge it)', async () => {
    const rec = {};
    await handleRelay(
      {
        headers: {
          'x-relay-secret': SECRET,
          'x-relay-target': 'https://gitlab.freedesktop.org/x',
          'user-agent': 'Mozilla/5.0 (X11; Linux) Chrome/120',
        },
      },
      { expectedSecret: SECRET, allowedHosts: ALLOWED, fetchImpl: fakeFetch(rec) },
    );
    expect(rec.init.headers['user-agent']).not.toMatch(/mozilla/i);
  });

  it('preserves a clean (non-Mozilla) User-Agent', async () => {
    const rec = {};
    await handleRelay(
      {
        headers: {
          'x-relay-secret': SECRET,
          'x-relay-target': 'https://gitlab.freedesktop.org/x',
          'user-agent': 'released/0.0.0 (+https://released.blabberate.com)',
        },
      },
      { expectedSecret: SECRET, allowedHosts: ALLOWED, fetchImpl: fakeFetch(rec) },
    );
    expect(rec.init.headers['user-agent']).toBe(
      'released/0.0.0 (+https://released.blabberate.com)',
    );
  });

  it('passes through rate-limit + link headers, drops content-encoding', async () => {
    const rec = {};
    const r = await handleRelay(
      {
        headers: { 'x-relay-secret': SECRET, 'x-relay-target': 'https://gitlab.freedesktop.org/x' },
      },
      {
        expectedSecret: SECRET,
        allowedHosts: ALLOWED,
        fetchImpl: fakeFetch(rec, {
          headers: {
            'ratelimit-remaining': '42',
            link: '<https://gitlab.freedesktop.org/x?page=2>; rel="next"',
            'content-encoding': 'gzip',
          },
        }),
      },
    );
    expect(r.headers['ratelimit-remaining']).toBe('42');
    expect(r.headers.link).toContain('page=2');
    expect(r.headers['content-encoding']).toBeUndefined();
  });
});
