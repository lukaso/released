// Web auth: resolves the GitHub token used for an outbound API call.
// Precedence (D9, D17 fix): X-User-Github-Token header > GITHUB_TOKEN secret > none.
// Also implements same-origin Origin-header check as defense-in-depth on /api/*.

import type { Env } from './env.js';

/** Pick the token to use for outbound GitHub calls for this request. */
export function resolveToken(env: Env | undefined, req: Request): string | undefined {
  const userPat = req.headers.get('x-user-github-token');
  if (userPat && userPat.trim()) return userPat.trim();
  if (env?.GITHUB_TOKEN && env.GITHUB_TOKEN.trim()) return env.GITHUB_TOKEN.trim();
  return undefined;
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
