// Pure relay logic for the Anubis-bypass container. Kept separate from the HTTP
// server (server.mjs) so it can be unit-tested with a fake fetch.
//
// Why this exists: gitlab.freedesktop.org (and other freedesktop/GNOME hosts)
// sit behind Anubis, which fingerprints the caller's TLS/HTTP2 stack BELOW the
// API-auth layer. Cloudflare's workerd fingerprint is challenged; Node's
// (undici) is not. This proxy runs in a Cloudflare Container (Node), so the
// Worker can route blocked-host API calls through it and get the bytes back.
//
// Trust model: the Worker still runs the whole findRelease algorithm. This
// container only ferries raw upstream bytes, gated by a shared secret and an
// SSRF allowlist — there is no client-supplied result to trust.

const DEFAULT_UA = 'released-relay/1.0 (+https://released.blabberate.com)';

// Headers we must never forward to the upstream (connection-scoped) — plus
// content-length, which we let the runtime recompute.
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
]);

/** Parse a comma-separated allowlist into a lowercased Set. */
export function parseAllowedHosts(raw) {
  return new Set(
    String(raw ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

/**
 * Core relay handler. Validates the shared secret and the target host, then
 * proxies the upstream GitLab API call, preserving status + body + the headers
 * the algorithm needs (rate-limit, link pagination, content-type).
 *
 * @param {{ method?: string, headers: Record<string, string>, body?: Uint8Array | null }} reqLike
 * @param {{ expectedSecret?: string, allowedHosts: Set<string>, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: Uint8Array | string }>}
 */
export async function handleRelay(reqLike, opts) {
  const { expectedSecret, allowedHosts, fetchImpl = fetch } = opts;
  const headers = lower(reqLike.headers);

  // 1. Auth — never relay without a matching shared secret.
  if (!expectedSecret || headers['x-relay-secret'] !== expectedSecret) {
    return plain(403, 'forbidden');
  }

  // 2. Target + SSRF guard — https only, host on the allowlist.
  const target = headers['x-relay-target'];
  let url;
  try {
    url = new URL(target);
  } catch {
    return plain(400, 'bad target');
  }
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname.toLowerCase())) {
    return plain(403, 'host not allowed');
  }

  // 3. Forward headers, minus relay-control + hop-by-hop. Sanitize the UA:
  //    Anubis challenges ANY User-Agent containing "Mozilla", so force a clean
  //    one if the forwarded value is missing or browser-like.
  const fwd = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith('x-relay-') || HOP_BY_HOP.has(k)) continue;
    fwd[k] = v;
  }
  if (!fwd['user-agent'] || /mozilla/i.test(fwd['user-agent'])) {
    fwd['user-agent'] = DEFAULT_UA;
  }

  const method = (reqLike.method ?? 'GET').toUpperCase();
  const init = { method, headers: fwd };
  if (method !== 'GET' && method !== 'HEAD' && reqLike.body) init.body = reqLike.body;

  const res = await fetchImpl(url.href, init);
  const body = new Uint8Array(await res.arrayBuffer());

  // Pass upstream headers through, dropping encoding/length so neither this
  // layer nor the Worker double-handles an already-decoded body.
  const out = {};
  res.headers.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (lk === 'content-encoding' || lk === 'content-length' || lk === 'transfer-encoding') return;
    out[lk] = value;
  });
  return { status: res.status, headers: out, body };
}

function lower(h) {
  const o = {};
  for (const [k, v] of Object.entries(h ?? {})) o[k.toLowerCase()] = v;
  return o;
}

function plain(status, body) {
  return { status, headers: { 'content-type': 'text/plain' }, body };
}
