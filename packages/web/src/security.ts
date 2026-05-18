// Security helpers (D13 + D17 fixes): strict CSP, per-response nonce, security headers.

/** Cryptographically random per-response nonce for inline scripts.
 *  Hex-encoded for compactness; only the inline `<script nonce="...">` and the
 *  CSP `script-src 'self' 'nonce-...'` need it. */
export function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Security headers for HTML responses. Applied to every server-rendered page.
 *  - CSP: tight; no inline scripts without nonce; img allowed from og.{domain}.
 *  - X-Frame-Options DENY; clickjacking protection.
 *  - Referrer-Policy strict-origin-when-cross-origin.
 *  - Permissions-Policy stripping things we don't need. */
export function securityHeaders(nonce: string, ogBaseUrl: string): Record<string, string> {
  const ogOrigin = new URL(ogBaseUrl).origin;
  const csp = [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    `img-src 'self' data: ${ogOrigin}`,
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
  ].join('; ');
  return {
    'content-security-policy': csp,
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  };
}
