// Single source of truth for constructing a provider inside the Worker.
//
// It resolves the host-scoped token, the extra-GitLab-hosts allowlist, and —
// for Anubis-protected hosts — a relay-backed fetch (Node fingerprint) so the
// lookup isn't blocked. Keeping this in one place means the four call sites
// (result / pr / lookup / lookup-bulk) can't drift on token precedence, UA, or
// relay wiring.

import { type Provider, providerFor } from '@released/core';
import { extraGitlabHostsFromEnv, resolveProviderToken } from './auth.js';
import type { Env } from './env.js';
import { makeRelayFetch } from './relay.js';

export function makeProvider(env: Env | undefined, req: Request, host: string): Provider {
  const token = resolveProviderToken(env, req, host);
  const extraGitlabHosts = extraGitlabHostsFromEnv(env);
  // undefined → core uses its default global fetch (direct). Defined → Anubis
  // host routed through the relay container.
  const fetch = makeRelayFetch(env, host);
  return providerFor(host, { token, extraGitlabHosts, fetch });
}
