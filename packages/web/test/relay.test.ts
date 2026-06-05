import { describe, expect, it, vi } from 'vitest';

// Mock the container helper so makeRelayFetch can be exercised without a real
// Durable Object / container binding.
const fetchSpy = vi.fn(async (_req: Request) => new Response('ok', { status: 200 }));
vi.mock('@cloudflare/containers', () => ({
  Container: class {},
  getContainer: vi.fn(() => ({ fetch: fetchSpy })),
}));

import { getContainer } from '@cloudflare/containers';
import type { Env } from '../src/env.js';
import { anubisHostsFromEnv, buildRelayRequest, makeRelayFetch } from '../src/relay.js';

const asEnv = (o: Record<string, unknown>) => o as unknown as Env;

describe('anubisHostsFromEnv', () => {
  it('defaults to freedesktop + gnome when unset', () => {
    const s = anubisHostsFromEnv(undefined);
    expect(s.has('gitlab.freedesktop.org')).toBe(true);
    expect(s.has('gitlab.gnome.org')).toBe(true);
  });

  it('parses and lowercases a configured list', () => {
    const s = anubisHostsFromEnv(asEnv({ ANUBIS_HOSTS: 'Git.Example.Org , foo.net' }));
    expect([...s]).toEqual(['git.example.org', 'foo.net']);
  });

  it('treats an empty string as "relay disabled" (no hosts)', () => {
    expect(anubisHostsFromEnv(asEnv({ ANUBIS_HOSTS: '' })).size).toBe(0);
  });
});

describe('buildRelayRequest', () => {
  it('puts target + secret in headers and preserves method + caller headers', () => {
    const r = buildRelayRequest(
      'https://gitlab.freedesktop.org/api/v4/x',
      { method: 'GET', headers: { 'private-token': 'tok', 'user-agent': 'released/0.0.0' } },
      'sek',
    );
    expect(r.headers.get('x-relay-target')).toBe('https://gitlab.freedesktop.org/api/v4/x');
    expect(r.headers.get('x-relay-secret')).toBe('sek');
    expect(r.headers.get('private-token')).toBe('tok');
    expect(r.headers.get('user-agent')).toBe('released/0.0.0');
    expect(r.method).toBe('GET');
  });
});

describe('makeRelayFetch — host selection', () => {
  const env = asEnv({ RELAY: {}, RELAY_SECRET: 'sek' });

  it('returns undefined when the binding is missing (→ caller goes direct)', () => {
    expect(
      makeRelayFetch(asEnv({ RELAY_SECRET: 'sek' }), 'gitlab.freedesktop.org'),
    ).toBeUndefined();
  });

  it('returns undefined when the secret is missing', () => {
    expect(makeRelayFetch(asEnv({ RELAY: {} }), 'gitlab.freedesktop.org')).toBeUndefined();
  });

  it('returns undefined for a non-Anubis host (e.g. gitlab.com)', () => {
    expect(makeRelayFetch(env, 'gitlab.com')).toBeUndefined();
  });

  it('returns a fetch that routes an Anubis host through the container', async () => {
    const f = makeRelayFetch(env, 'gitlab.freedesktop.org');
    expect(f).toBeTypeOf('function');
    const res = await (f as typeof fetch)('https://gitlab.freedesktop.org/api/v4/x', {
      headers: { 'user-agent': 'released/0.0.0' },
    });
    expect(res.status).toBe(200);
    expect(getContainer).toHaveBeenCalled();
    const sent = fetchSpy.mock.calls.at(-1)?.[0] as Request;
    expect(sent.headers.get('x-relay-target')).toBe('https://gitlab.freedesktop.org/api/v4/x');
    expect(sent.headers.get('x-relay-secret')).toBe('sek');
  });
});
