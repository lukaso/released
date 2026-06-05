// Worker environment bindings (wrangler.toml + secrets).

export type Env = {
  /** Server-side GitHub token (PAT or GitHub App secret). Set via:
   *  `wrangler secret put GITHUB_TOKEN`. Drives the anonymous fast path. */
  GITHUB_TOKEN?: string;

  /** Default GitLab PAT — used for gitlab.com when no host-specific token is set.
   *  Critical for Worker traffic: anonymous calls share the edge IP's budget. */
  GITLAB_TOKEN?: string;

  /** Comma-separated list of EXTRA GitLab hosts to recognize on top of the
   *  built-in allowlist. Example: "gitlab.acme.com,git.example.net". */
  EXTRA_GITLAB_HOSTS?: string;

  /** Host-specific GitLab PATs read at request time via env.GITLAB_TOKEN_<HOST>.
   *  Host name is uppercased with `.` → `_`. E.g. GITLAB_TOKEN_GITLAB_GNOME_ORG.
   *  Indexed below as a string-keyed bag because wrangler secrets are name-by-name. */
  [key: `GITLAB_TOKEN_${string}`]: string | undefined;

  /** Public base URL of the web Worker (e.g. https://released.blabberate.com). */
  PUBLIC_BASE_URL?: string;

  /** Base URL of the web-og Worker (e.g. https://og.released.blabberate.com).
   *  Used to generate og:image URLs. */
  OG_BASE_URL?: string;

  /** Cloudflare Workers Analytics Engine binding (optional). */
  ANALYTICS?: {
    writeDataPoint(dp: AnalyticsEngineDataPoint): void;
  };

  /** Shared secret for the Worker↔relay-container handshake. The container
   *  rejects any request whose `x-relay-secret` doesn't match. Set via
   *  `wrangler secret put RELAY_SECRET`; the GitlabRelay DO mirrors it into the
   *  container env. */
  RELAY_SECRET?: string;

  /** Comma-separated hosts to route through the relay container (Anubis-
   *  protected). Defaults to gitlab.freedesktop.org,gitlab.gnome.org when unset;
   *  an explicit empty string disables the relay. */
  ANUBIS_HOSTS?: string;

  /** Container binding (Durable Object) for the GitLab relay. Present only once
   *  the [[containers]] block in wrangler.toml is deployed; absent in tests and
   *  in `wrangler dev` without containers, in which case lookups go direct. */
  RELAY?: DurableObjectNamespace<import('./relay.js').GitlabRelay>;
};

export type AnalyticsEngineDataPoint = {
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
  const candidate = `${u.protocol}//og.${u.host}`;
  // `og.<host>` is an INVALID URL when host is an IP (e.g. og.127.0.0.1 — the
  // trailing numeric label makes URL parsing attempt and fail an IPv4 parse).
  // That 500s every Layout-rendered page under `wrangler dev` when the worker is
  // hit via its IP form. Fall back to the origin: og images aren't reachable by
  // crawlers on localhost anyway, so locally they only need to be a valid URL.
  try {
    new URL(candidate);
    return candidate;
  } catch {
    return u.origin;
  }
}
