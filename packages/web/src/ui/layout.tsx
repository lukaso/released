// HTML shell with CSP, nonce, OG meta, and the locked design system.

import type { LookupResult } from '@released/core';
import { html, raw } from 'hono/html';
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
        {/* Geist Sans + Mono are self-hosted under /fonts/ (Workers Assets).
            No googleapis/gstatic preconnects — visitor IPs stay on our edge. */}
        <link
          rel="preload"
          as="font"
          type="font/woff2"
          href="/fonts/Geist-Variable.woff2"
          crossorigin=""
        />
        <link
          rel="preload"
          as="font"
          type="font/woff2"
          href="/fonts/GeistMono-Variable.woff2"
          crossorigin=""
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
        {/* biome-ignore lint/suspicious/noExplicitAny: children is typed `unknown` (Layout accepts arbitrary JSX); Hono's renderer needs a renderable child, and `as any` is the localized escape hatch. */}
        <div class="wrap">{props.children as any}</div>
        <script nonce={props.nonce}>{raw(CLIENT_JS)}</script>
      </body>
    </html>
  );
}

/** Inline client script: copy buttons + form loading-state handler. */
const CLIENT_JS = `
(function(){
  // Loading-state on any form opted in via [data-loading-form]. We mark the
  // form with .loading on submit so the CSS swaps the button label to
  // "Looking up…" and shows the animated dots. Browser then continues the
  // full-page navigation; the old page (with the loading state visible)
  // stays painted until the new page is ready, which is exactly the
  // "wait scroller" UX we want on cold lookups (4-10s on first hit).
  document.querySelectorAll('form[data-loading-form]').forEach(function(form){
    form.addEventListener('submit', function(){
      form.classList.add('loading');
      // Prevent double-submit by disabling the button. We disable AFTER the
      // event has been processed (via setTimeout 0) because disabling it
      // synchronously in the handler can cancel the form submission in some
      // browsers (Safari especially).
      setTimeout(function(){
        var btn = form.querySelector('button[type="submit"]');
        if (btn) btn.disabled = true;
      }, 0);
    });
  });

  // Reset the loading state when the page is restored from the browser's
  // back-forward cache (BFCache). Without this, hitting Back after a
  // submitted lookup shows the spinner still spinning and the button still
  // disabled, because BFCache restores the DOM exactly as it was at unload.
  window.addEventListener('pageshow', function(e){
    if (!e.persisted) return;
    document.querySelectorAll('form[data-loading-form]').forEach(function(form){
      form.classList.remove('loading');
      var btn = form.querySelector('button[type="submit"]');
      if (btn) btn.disabled = false;
    });
  });

  // Project chip clicks — insert the alias into the search input. The
  // SHA detection / replacement logic mirrors computeChipClickInputValue
  // in chip-click.ts (the tested source of truth). Kept short and inline
  // so drift stays obvious; if you change it, update chip-click.ts too.
  document.addEventListener('click', function(e){
    var t = e.target;
    if (!(t instanceof HTMLElement)) return;
    var chip = t.closest('.project-chip');
    if (!chip) return;
    var alias = chip.getAttribute('data-alias');
    if (!alias) return;
    e.preventDefault();
    var input = document.getElementById('q');
    if (!input) return;
    var trimmed = input.value.trim();
    input.value = /^[0-9a-f]{7,40}$/i.test(trimmed) ? (alias + ' ' + trimmed) : (alias + ' ');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    chip.classList.add('project-chip--just-clicked');
    setTimeout(function(){ chip.classList.remove('project-chip--just-clicked'); }, 200);
  });

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
    var repo = r.input.repo.projectPath;
    var host = r.input.repo.host;
    var sha = r.canonicalSha.slice(0,7);
    // Build the host-aware permalink path (mirrors paths.ts on the server).
    var permaPath = host === 'github.com'
      ? '/r/' + repo + '/c/' + sha
      : '/h/' + host + '/r/' + encodeURIComponent(repo) + '/c/' + sha;
    var perma = window.location.origin + permaPath;
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
