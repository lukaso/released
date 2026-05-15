// HTML shell with CSP, nonce, OG meta, and the locked design system.

import { html, raw } from 'hono/html';
import type { LookupResult } from '@released/core';
import { OgMeta } from './og-meta.js';
import { STYLES } from './styles.js';

export type LayoutProps = {
  title: string;
  /** Per-response nonce for CSP `script-src 'self' 'nonce-...'`. */
  nonce: string;
  ogBaseUrl: string;
  publicUrl: string;
  /** When present, OG meta reflects this result. */
  ogResult?: LookupResult | null;
  ogFallbackTitle?: string;
  children: unknown;
};

export function Layout(props: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600;700&display=swap"
        />
        <style>{raw(STYLES)}</style>
        <OgMeta
          ogBaseUrl={props.ogBaseUrl}
          publicUrl={props.publicUrl}
          result={props.ogResult ?? null}
          fallbackTitle={props.ogFallbackTitle}
        />
      </head>
      <body>
        <div class="wrap">{props.children as any}</div>
        <script nonce={props.nonce}>{raw(CLIENT_JS)}</script>
      </body>
    </html>
  );
}

/** Inline client script: copy buttons + tiny no-JS-fallback form handling. */
const CLIENT_JS = `
(function(){
  document.addEventListener('click', function(e){
    var t = e.target;
    if (!(t instanceof HTMLElement)) return;
    var fmt = t.getAttribute('data-copy');
    if (!fmt) return;
    e.preventDefault();
    var data = window.__RELEASED_RESULT__;
    if (!data) return;
    var text = formatForCopy(data, fmt);
    if (!text) return;
    navigator.clipboard.writeText(text).then(function(){
      var orig = t.textContent;
      t.textContent = 'Copied!';
      setTimeout(function(){ t.textContent = orig; }, 1200);
    });
  });
  function formatForCopy(r, fmt){
    var repo = r.input.repo.owner + '/' + r.input.repo.repo;
    var sha = r.canonicalSha.slice(0,7);
    var perma = window.location.origin + '/r/' + r.input.repo.owner + '/' + r.input.repo.repo + '/c/' + sha;
    var tag = r.firstRelease ? r.firstRelease.tag : null;
    if (!tag) return null;
    if (fmt === 'markdown') {
      var url = r.firstRelease.url;
      return '✅ \\\`' + sha + '\\\` in \\\`' + repo + '\\\` is first released in [**' + tag + '**](' + url + ') (' + r.firstRelease.date.slice(0,10) + '). [Permalink](' + perma + ').';
    }
    if (fmt === 'slack') {
      return '*' + tag + '* shipped ' + r.firstRelease.date.slice(0,10) + ' contains \\\`' + sha + '\\\` in \\\`' + repo + '\\\` <' + perma + '|details>';
    }
    return perma;
  }
})();
`;
