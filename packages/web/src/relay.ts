// Anubis-bypass relay (Worker side).
//
// gitlab.freedesktop.org (and other freedesktop/GNOME hosts) sit behind Anubis,
// which fingerprints the caller's TLS/HTTP2 stack below the API-auth layer.
// workerd's fingerprint is challenged; Node's (undici) is not. So for those
// hosts we route the provider's fetches through a Cloudflare Container running
// Node (see container/ + Dockerfile). The Worker still runs the whole
// findRelease algorithm — the container only ferries raw upstream bytes, gated
// by a shared secret (RELAY_SECRET) and an SSRF allowlist.
//
// Wiring: core accepts an injectable `fetch` (ProviderOpts.fetch). makeProvider
// (provider.ts) passes makeRelayFetch(env, host) for Anubis hosts; everything
// else fetches directly.

import { Container, getContainer } from '@cloudflare/containers';
import type { Env } from './env.js';

/** Hosts that are behind Anubis and must be relayed. Override via ANUBIS_HOSTS
 *  (comma-separated). An explicit empty string disables the relay entirely. */
const DEFAULT_ANUBIS_HOSTS = ['gitlab.freedesktop.org', 'gitlab.gnome.org'] as const;

export function anubisHostsFromEnv(env: Env | undefined): Set<string> {
  const raw = env?.ANUBIS_HOSTS;
  if (raw === undefined) return new Set<string>(DEFAULT_ANUBIS_HOSTS);
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

/** The container Durable Object: a Node fetch proxy whose TLS fingerprint clears
 *  Anubis. Image + lifecycle are declared in wrangler.toml; this class only
 *  passes config into the container process. */
export class GitlabRelay extends Container<Env> {
  override defaultPort = 8080;
  // Anubis lookups are rare and cache-fronted, so sleep quickly to stay near $0.
  override sleepAfter = '3m';

  constructor(ctx: ConstructorParameters<typeof Container>[0], env: Env) {
    super(ctx, env);
    this.envVars = {
      RELAY_SECRET: env.RELAY_SECRET ?? '',
      // The container's SSRF allowlist == the hosts we'd ever relay.
      RELAY_ALLOWED_HOSTS: [...anubisHostsFromEnv(env)].join(','),
    };
  }
}

/** Build the Request the container expects: target + secret in headers, with the
 *  caller's method/headers/body/signal preserved. Pure → unit-testable. */
export function buildRelayRequest(
  target: string,
  init: RequestInit | undefined,
  secret: string,
): Request {
  const headers = new Headers(init?.headers);
  headers.set('x-relay-target', target);
  headers.set('x-relay-secret', secret);
  return new Request('https://relay.internal/relay', {
    method: init?.method ?? 'GET',
    headers,
    body: init?.body ?? null,
    signal: init?.signal ?? null,
  });
}

/** Returns a fetch impl that tunnels through the relay container, or undefined
 *  when this host shouldn't (not Anubis) or can't (no binding/secret) use it —
 *  the caller then fetches directly. */
export function makeRelayFetch(env: Env | undefined, host: string): typeof fetch | undefined {
  if (!env?.RELAY || !env.RELAY_SECRET) return undefined;
  if (!anubisHostsFromEnv(env).has(host.toLowerCase())) return undefined;
  const binding = env.RELAY;
  const secret = env.RELAY_SECRET;
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const target =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return getContainer(binding, 'gitlab-relay').fetch(buildRelayRequest(target, init, secret));
  }) as typeof fetch;
}
