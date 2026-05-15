// Markdown sanitization for release notes (T4 — micromark, Workers-friendly).
//
// micromark with `allowDangerousHtml: false` (the default — we just don't pass
// the html extensions) does NOT pass through raw HTML, so <script>, <iframe>,
// <svg onload=...> etc. become escaped text. We additionally post-process the
// rendered HTML to neutralize unsafe URI schemes on <a href> / <img src>.

import { micromark } from 'micromark';
import { SanitizeError } from './errors.js';

/** Render a GitHub release-notes markdown string to safe HTML.
 *  Returns null for empty/whitespace input. */
export async function renderReleaseNotes(markdown: string): Promise<string | null> {
  if (!markdown || !markdown.trim()) return null;
  try {
    // micromark with the default extension set: no raw HTML, no script.
    const html = micromark(markdown, {
      allowDangerousHtml: false,
      allowDangerousProtocol: false,
    });
    return scrubUnsafeAttrs(html);
  } catch (cause) {
    throw new SanitizeError(cause);
  }
}

/** Defense-in-depth: scrub any href/src that slipped through with an unsafe
 *  scheme (javascript:, vbscript:, data: with text/html). Belt-and-suspenders
 *  on top of micromark's `allowDangerousProtocol: false`. */
function scrubUnsafeAttrs(html: string): string {
  // Replace href/src values that start with an unsafe scheme.
  return html.replace(
    /\b(href|src)\s*=\s*("|')\s*(javascript|vbscript|data:text\/html|file):[^"']*\2/gi,
    '$1="about:blank"',
  );
}
