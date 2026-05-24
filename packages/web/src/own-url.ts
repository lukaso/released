// Recognize the site's OWN permalink / badge URLs pasted back into the search
// box, and map them to the canonical permalink path. Without this, pasting the
// address bar (or any fragment of it) feeds "released.blabberate.com/…" — or the
// /h/-stripped "gitlab.gnome.org/p/…" — to parseInput, which rejects it as an
// unrecognized host. Here we just route it straight back to its permalink.
//
// Lives in the web layer (not core/parse-input) because these are released.*
// route shapes, not git-host URL shapes.

import type { RepoRef } from '@released/core';
import { commitPermalinkPath, prPermalinkPath } from './paths.js';

const SHA = '[0-9a-f]{7,40}';

function fed(host: string, projectEnc: string): RepoRef {
  return { host: host.toLowerCase(), projectPath: decodeURIComponent(projectEnc) };
}

/**
 * If `input` is one of our permalink/badge URLs, return the canonical permalink
 * path (e.g. `/h/gitlab.gnome.org/p/GNOME%2Fgtk/9951`). Otherwise return null so
 * the caller falls through to parseInput.
 *
 * `selfHosts` are hostnames that belong to us (public base + request host); a
 * leading one is stripped so the full-URL and path-only forms both match.
 */
export function recognizeOwnUrl(input: string, selfHosts: string[]): string | null {
  let s = input.trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\//i, '');

  // Strip a leading "<our host>/" so the full-URL form reduces to the path form.
  const lower = s.toLowerCase();
  for (const h of selfHosts) {
    const hl = h.toLowerCase();
    if (lower === hl) return null;
    if (lower.startsWith(`${hl}/`)) {
      s = s.slice(h.length + 1);
      break;
    }
  }
  s = s.replace(/^\/+/, '').replace(/\/+$/, '');
  s = s.replace(/\/badge\.svg$/i, '');

  // Federated, with the /h/ prefix: h/<host>/p/<projectEnc>/<n> | r/.../c/<sha>
  let m = s.match(/^h\/([\w.-]+)\/p\/([^\/]+)\/(\d+)$/i);
  if (m?.[1] && m[2] && m[3]) return prPermalinkPath(fed(m[1], m[2]), Number(m[3]));
  m = s.match(new RegExp(`^h/([\\w.-]+)/r/([^/]+)/c/(${SHA})$`, 'i'));
  if (m?.[1] && m[2] && m[3]) return commitPermalinkPath(fed(m[1], m[2]), m[3].toLowerCase());

  // Federated, /h/ prefix dropped (host must look dotted): <host>/p/<enc>/<n>
  m = s.match(/^([\w.-]+\.[\w.-]+)\/p\/([^\/]+)\/(\d+)$/i);
  if (m?.[1] && m[2] && m[3]) return prPermalinkPath(fed(m[1], m[2]), Number(m[3]));
  m = s.match(new RegExp(`^([\\w.-]+\\.[\\w.-]+)/r/([^/]+)/c/(${SHA})$`, 'i'));
  if (m?.[1] && m[2] && m[3]) return commitPermalinkPath(fed(m[1], m[2]), m[3].toLowerCase());

  // GitHub permalink paths: p/<owner>/<repo>/<n> | r/<owner>/<repo>/c/<sha>
  m = s.match(/^p\/([\w.-]+)\/([\w.-]+)\/(\d+)$/i);
  if (m?.[1] && m[2] && m[3]) {
    return prPermalinkPath({ host: 'github.com', projectPath: `${m[1]}/${m[2]}` }, Number(m[3]));
  }
  m = s.match(new RegExp(`^r/([\\w.-]+)/([\\w.-]+)/c/(${SHA})$`, 'i'));
  if (m?.[1] && m[2] && m[3]) {
    return commitPermalinkPath(
      { host: 'github.com', projectPath: `${m[1]}/${m[2]}` },
      m[3].toLowerCase(),
    );
  }

  return null;
}
