// Worker environment bindings (wrangler.toml + secrets).

export type Env = {
  /** Server-side GitHub token (PAT or GitHub App secret). Set via:
   *  `wrangler secret put GITHUB_TOKEN`. Drives the anonymous fast path. */
  GITHUB_TOKEN?: string;

  /** Public base URL of the web Worker (e.g. https://released.blabberate.com). */
  PUBLIC_BASE_URL?: string;

  /** Base URL of the web-og Worker (e.g. https://og.released.blabberate.com).
   *  Used to generate og:image URLs. */
  OG_BASE_URL?: string;

  /** Cloudflare Workers Analytics Engine binding (optional). */
  ANALYTICS?: {
    writeDataPoint(dp: AnalyticsEngineDataPoint): void;
  };
};

type AnalyticsEngineDataPoint = {
  indexes?: string[];
  blobs?: string[];
  doubles?: number[];
};

/** Resolve the public base URL (defaults to the request origin if no env var). */
export function publicBaseUrl(env: Env | undefined, req: Request): string {
  if (env?.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL.replace(/\/$/, '');
  return new URL(req.url).origin;
}

/** Resolve the web-og worker base URL (defaults to "og." subdomain). */
export function ogBaseUrl(env: Env | undefined, req: Request): string {
  if (env?.OG_BASE_URL) return env.OG_BASE_URL.replace(/\/$/, '');
  const u = new URL(req.url);
  return `${u.protocol}//og.${u.host}`;
}
