// HTML shell with CSP, nonce, OG meta, and the locked design system.

import type { LookupResult } from '@released/core';
import { html, raw } from 'hono/html';
import { OgMeta } from './og-meta.js';
import { STYLES } from './styles.js';

export type LayoutProps = {
  title: string;
  /** Optional <meta name="description"> for search snippets. Omitted on pages
   *  where a generic description would hurt more than help (e.g. result pages
   *  carry their own OG description already). */
  description?: string;
  /** Per-response nonce for CSP `script-src 'self' 'nonce-...'`. */
  nonce: string;
  ogBaseUrl: string;
  publicUrl: string;
  /** When present, OG meta reflects this result. */
  ogResult?: LookupResult | null;
  ogFallbackTitle?: string;
  /** Pre-built og:image URL that wins over the result-derived one (#53). */
  ogImageOverride?: string;
  children: unknown;
};

export function Layout(props: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        {props.description && <meta name="description" content={props.description} />}
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
          imageOverride={props.ogImageOverride}
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
      // Pin the preview to the format the user just copied.
      pinnedFmt = fmt;
      showPreview(fmt);
      // Fire-and-forget analytics beacon: copying a badge/link is the seeding
      // action we can't see server-side (no request otherwise). sendBeacon is
      // non-blocking and survives navigation; same-origin only (CSP connect-src
      // 'self'), and a non-safelisted JSON body means cross-site beacons are
      // blocked by the browser. Records action + already-public host/repo only.
      try {
        if (navigator.sendBeacon && data.input && data.input.repo) {
          var payload = JSON.stringify({
            type: 'copy',
            format: fmt,
            host: data.input.repo.host,
            repo: data.input.repo.projectPath
          });
          navigator.sendBeacon('/api/event', new Blob([payload], { type: 'application/json' }));
        }
      } catch (e) { /* analytics must never break the copy UX */ }
    });
  });
  // Host- AND kind-aware permalink path (mirrors permalinkPathForInput in
  // paths.ts on the server). PR/MR results keep their /p/ permalink so the
  // embedded badge tracks the merge request.
  function permaPath(r){
    var repo = r.input.repo.projectPath;
    var host = r.input.repo.host;
    if (r.input.kind === 'pr') {
      var n = r.input.number;
      return host === 'github.com'
        ? '/p/' + repo + '/' + n
        : '/h/' + host + '/p/' + encodeURIComponent(repo) + '/' + n;
    }
    var sha = r.canonicalSha.slice(0,7);
    return host === 'github.com'
      ? '/r/' + repo + '/c/' + sha
      : '/h/' + host + '/r/' + encodeURIComponent(repo) + '/c/' + sha;
  }
  function formatForCopy(r, fmt){
    var repo = r.input.repo.projectPath;
    var sha = r.canonicalSha.slice(0,7);
    var perma = window.location.origin + permaPath(r);
    var tag = r.firstRelease ? r.firstRelease.tag : null;
    // The human headline (PR/MR title or commit subject). Woven into every
    // format EXCEPT link-only, so a pasted badge/snippet says WHAT shipped.
    var subject = r.subject || null;
    // link works whether or not it's released yet; never carries the headline.
    if (fmt === 'link') return perma;
    if (fmt === 'badge') {
      var badge = '[![released](' + perma + '/badge.svg)](' + perma + ')';
      return subject ? badge + ' **' + subject + '**' : badge;
    }
    if (fmt === 'slack') {
      var slead = subject ? '*' + subject + '* — ' : '';
      if (!tag) {
        // No tag yet (not merged / not released). Slack mrkdwn is plain text and
        // won't auto-update, so we DON'T bake "not yet released" into the message —
        // it would stale-lock once the commit ships. Point to the permalink with a
        // live-status label instead. Unmerged PRs have no SHA (canonicalSha === ''):
        // reference the PR/MR by number so the snippet still reads cleanly.
        var ref = sha
          ? '\\\`' + sha + '\\\`'
          : (r.input.kind === 'pr' ? (r.input.repo.host === 'github.com' ? '#' : '!') + r.input.number : '');
        var refIn = ref ? ref + ' in ' : '';
        return slead + refIn + '\\\`' + repo + '\\\` — <' + perma + '|live release status>';
      }
      return slead + '*' + tag + '* shipped ' + r.firstRelease.date.slice(0,10) + ' contains \\\`' + sha + '\\\` in \\\`' + repo + '\\\` <' + perma + '|details>';
    }
    return perma;
  }

  // Live copy preview. Mirrors what each format produces: the rendered image
  // for "as Badge", the literal copy string for the rest. Hover/focus previews
  // without copying; click pins. Stays hidden when there's no result payload
  // (e.g. the homepage EXAMPLE has the buttons but no window.__RELEASED_RESULT__).
  var previewBox = document.querySelector('[data-copy-preview]');
  var previewImg = previewBox && previewBox.querySelector('.copy-preview-badge');
  var previewText = previewBox && previewBox.querySelector('.copy-preview-text');
  var previewLabel = previewBox && previewBox.querySelector('[data-copy-preview-label]');
  var pinnedFmt = 'badge';
  function showPreview(fmt){
    var data = window.__RELEASED_RESULT__;
    if (!previewBox || !data) return;
    var isBadge = fmt === 'badge';
    if (previewImg){
      if (isBadge){ previewImg.src = window.location.origin + permaPath(data) + '/badge.svg'; previewImg.hidden = false; }
      else { previewImg.hidden = true; }
    }
    if (previewText) previewText.textContent = formatForCopy(data, fmt) || '';
    if (previewLabel) previewLabel.textContent = isBadge ? 'Badge preview' : 'Copies';
    previewBox.hidden = false;
  }
  if (previewBox && window.__RELEASED_RESULT__){
    document.querySelectorAll('[data-copy]').forEach(function(btn){
      var f = btn.getAttribute('data-copy');
      btn.addEventListener('pointerenter', function(){ showPreview(f); });
      btn.addEventListener('focus', function(){ showPreview(f); });
      btn.addEventListener('pointerleave', function(){ showPreview(pinnedFmt); });
      btn.addEventListener('blur', function(){ showPreview(pinnedFmt); });
    });
    // Populate only when the share disclosure is first opened — a clean
    // permalink visit (disclosure closed) then triggers no badge fetch.
    var share = document.querySelector('details.share');
    if (share) {
      share.addEventListener('toggle', function(){ if (share.open) showPreview(pinnedFmt); });
    } else {
      showPreview(pinnedFmt);
    }
  }
})();
`;
