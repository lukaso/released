// Web auth: resolves the provider API token used for an outbound API call.
// Precedence per provider:
//   GitHub: X-User-Github-Token header > GITHUB_TOKEN secret > none
//   GitLab: X-User-Gitlab-Token header > GITLAB_TOKEN_<HOST> secret > GITLAB_TOKEN secret > none
// Also implements same-origin Origin-header check as defense-in-depth on /api/*.

import type { Env } from './env.js';

/** Pick the token to use for outbound GitHub calls for this request. */
export function resolveToken(env: Env | undefined, req: Request): string | undefined {
  const userPat = req.headers.get('x-user-github-token');
  if (userPat && userPat.trim()) return userPat.trim();
  if (env?.GITHUB_TOKEN && env.GITHUB_TOKEN.trim()) return env.GITHUB_TOKEN.trim();
  return undefined;
}

/** Resolve a provider API token for a given host. Honors per-host Worker secrets
 *  (GITLAB_TOKEN_<HOST>) so different self-hosted GitLab instances can use
 *  different PATs. */
export function resolveProviderToken(
  env: Env | undefined,
  req: Request,
  host: string,
): string | undefined {
  if (host === 'github.com') return resolveToken(env, req);
  // GitLab path
  const userPat = req.headers.get('x-user-gitlab-token');
  if (userPat && userPat.trim()) return userPat.trim();
  if (env) {
    const hostKey = `GITLAB_TOKEN_${host.toUpperCase().replace(/[.-]/g, '_')}` as const;
    const hostSecret = (env as Record<string, string | undefined>)[hostKey];
    if (hostSecret && hostSecret.trim()) return hostSecret.trim();
    if (env.GITLAB_TOKEN && env.GITLAB_TOKEN.trim()) return env.GITLAB_TOKEN.trim();
  }
  return undefined;
}

/** Parse EXTRA_GITLAB_HOSTS env var into a string[] (trimmed, empty entries dropped). */
export function extraGitlabHostsFromEnv(env: Env | undefined): readonly string[] {
  const raw = env?.EXTRA_GITLAB_HOSTS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/** Returns true if the request's Origin matches the worker's own origin (same-origin)
 *  or the request has no Origin header (which is the case for server-to-server,
 *  curl, and unfurl bots). Returns false ONLY when a cross-origin browser is
 *  trying to call /api/*. */
export function checkSameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true; // not a browser cross-origin call
  try {
    const reqUrl = new URL(req.url);
    const originUrl = new URL(origin);
    return reqUrl.origin === originUrl.origin;
  } catch {
    return false;
  }
}

/** User-Agent allowlist for unfurl bots (Slackbot, Twitterbot, etc.).
 *  These get the special deferred-render card on cache miss with no budget. */
const UNFURL_BOTS = [
  /Slackbot/i,
  /Twitterbot/i,
  /facebookexternalhit/i,
  /LinkedInBot/i,
  /Discordbot/i,
  /TelegramBot/i,
];

export function isUnfurlBot(req: Request): boolean {
  const ua = req.headers.get('user-agent');
  if (!ua) return false;
  return UNFURL_BOTS.some((re) => re.test(ua));
}
