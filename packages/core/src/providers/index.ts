// Provider routing — pick the right Provider implementation for an input's host.
// Hard-coded allowlist of known GitLab instances seeds the default; the Worker
// and CLI can extend it via env var / config without code changes.

import { UnsupportedHostError } from '../errors.js';
import type { Provider, ProviderOpts } from '../provider.js';
import { makeBitbucketProvider } from './bitbucket/client.js';
import { makeGithubProvider } from './github/client.js';
import { makeGitlabProvider } from './gitlab/client.js';

/** Built-in known GitLab hostnames. Extend at runtime via the `extraGitlabHosts`
 *  option (read by web Worker from EXTRA_GITLAB_HOSTS env var, by CLI from
 *  ~/.released.toml or --gitlab-host flag). */
export const KNOWN_GITLAB_HOSTS: ReadonlySet<string> = new Set([
  'gitlab.com',
  'gitlab.gnome.org',
  'gitlab.freedesktop.org',
  'salsa.debian.org',
  'invent.kde.org',
  'gitlab.kitware.com',
]);

export type ProviderForOpts = ProviderOpts & {
  /** Extra GitLab hosts to recognize on top of the built-in allowlist. */
  extraGitlabHosts?: readonly string[];
};

/** Bitbucket Cloud is a single fixed host (no self-hosted federation), so it
 *  sits alongside github.com as a built-in known host — no extra-hosts opt. */
export const BITBUCKET_HOST = 'bitbucket.org';

/** Resolve a host to its provider, or throw UnsupportedHostError listing what we know. */
export function providerFor(host: string, opts: ProviderForOpts = {}): Provider {
  if (host === 'github.com') return makeGithubProvider(opts);
  if (host === BITBUCKET_HOST) return makeBitbucketProvider(opts);
  if (KNOWN_GITLAB_HOSTS.has(host) || (opts.extraGitlabHosts?.includes(host) ?? false)) {
    return makeGitlabProvider(host, opts);
  }
  const supported = [
    'github.com',
    BITBUCKET_HOST,
    ...KNOWN_GITLAB_HOSTS,
    ...(opts.extraGitlabHosts ?? []),
  ];
  throw new UnsupportedHostError(host, supported);
}

/** Predicate: is this host one we know how to route? Useful for parseInput
 *  dispatch (decide which URL-shape table to apply). */
export function isKnownHost(host: string, extraGitlabHosts: readonly string[] = []): boolean {
  if (host === 'github.com') return true;
  if (host === BITBUCKET_HOST) return true;
  if (KNOWN_GITLAB_HOSTS.has(host)) return true;
  if (extraGitlabHosts.includes(host)) return true;
  return false;
}

export { makeBitbucketProvider } from './bitbucket/client.js';
export { makeGithubProvider } from './github/client.js';
export { makeGitlabProvider } from './gitlab/client.js';
