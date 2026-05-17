// Shared HTTP plumbing — retry, timeout, rate-limit parsing. Used by both
// GithubProvider and GitlabProvider. Prevents drift between providers and
// keeps the 30 lines of fetch ceremony in one place.

import { NetworkError, ProviderJsonError, ProviderServerError, RateLimitError } from '../errors.js';
import type { RateLimitInfo } from '../types.js';

export type CallOpts = {
  fetchImpl: typeof fetch;
  /** How many retries on 5xx (default 2 → 3 total attempts). */
  retries: number;
  /** Bounds how long a single API call can hang. GitHub's /compare on huge repos
   *  (kubernetes) can take 5-10s legitimately; 12s gives margin without letting
   *  a runaway call eat the whole deadline budget. */
  perRequestTimeoutMs?: number;
  /** Provider host for error attribution + rate-limit metadata. */
  providerHost: string;
  /** How this provider parses its rate-limit headers from a Response.
   *  Different providers use different header names:
   *    GitHub: x-ratelimit-{remaining,limit,reset}
   *    GitLab: RateLimit-{Remaining,Limit,Reset}
   */
  parseRateLimit: (res: Response) => RateLimitInfo | null;
  /** Optional: provider-specific server-error class. GitHub uses GitHubServerError
   *  (legacy public API surface); GitLab and future providers default to
   *  ProviderServerError. Keeping per-provider error classes preserves the
   *  catch-by-typed-instance contract for callers. */
  makeServerError?: (status: number, statusText: string) => Error;
};

export const DEFAULT_PER_REQUEST_TIMEOUT_MS = 12_000;

/** Issue a fetch with retry-on-5xx and uniform error translation.
 *  Returns the Response on 2xx and 4xx (caller inspects status to translate
 *  4xx into typed errors). Throws RateLimitError / NetworkError / ProviderServerError. */
export async function callWithRetry(
  url: string,
  init: RequestInit,
  opts: CallOpts,
): Promise<Response> {
  const timeoutMs = opts.perRequestTimeoutMs ?? DEFAULT_PER_REQUEST_TIMEOUT_MS;
  let lastStatus = 0;
  let lastStatusText = '';
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    let res: Response;
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      res = await opts.fetchImpl(url, { ...init, signal: ctrl.signal });
    } catch (cause) {
      // Per-request timeout fired → abort. Don't retry — it'd just time out again
      // and multiply the wall-clock cost. Surface immediately so the caller can move on.
      const isAbort = (cause as Error)?.name === 'AbortError';
      if (isAbort || attempt >= opts.retries) throw new NetworkError(cause);
      await backoff(attempt);
      continue;
    } finally {
      clearTimeout(timeoutId);
    }
    // 5xx → retry
    if (res.status >= 500 && res.status <= 599) {
      lastStatus = res.status;
      lastStatusText = res.statusText;
      if (attempt >= opts.retries) {
        throw opts.makeServerError
          ? opts.makeServerError(lastStatus, lastStatusText)
          : new ProviderServerError(opts.providerHost, lastStatus, lastStatusText);
      }
      await backoff(attempt);
      continue;
    }
    // Rate-limit detection: 403/429 with remaining=0
    if (res.status === 403 || res.status === 429) {
      const rl = opts.parseRateLimit(res);
      if (rl && rl.remaining === 0) throw new RateLimitError(rl.resetAt, opts.providerHost);
    }
    return res;
  }
  // Unreachable in practice, but TypeScript wants a terminal.
  const fallbackStatus = lastStatus || 0;
  const fallbackText = lastStatusText || 'unknown';
  throw opts.makeServerError
    ? opts.makeServerError(fallbackStatus, fallbackText)
    : new ProviderServerError(opts.providerHost, fallbackStatus, fallbackText);
}

async function backoff(attempt: number): Promise<void> {
  // 100ms, 300ms, 700ms — capped jitter.
  const ms = 100 * 2 ** attempt + Math.floor(Math.random() * 50);
  await new Promise((r) => setTimeout(r, ms));
}

export async function readJson<T = unknown>(res: Response): Promise<T> {
  // Defensive: providers occasionally return HTML (Cloudflare interstitial,
  // anti-bot challenge, captive portal between Worker and provider) with a
  // 200 status. Catch the parse error and surface a friendly typed error
  // including the response status and a snippet, so callers don't get an
  // unhandled SyntaxError → 500.
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    const snippet = text.slice(0, 120).replace(/\s+/g, ' ');
    throw new ProviderJsonError(res.status, snippet, cause);
  }
}

export function enc(s: string): string {
  return encodeURIComponent(s);
}
