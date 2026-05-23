// Shared result-card rendering. Used by routes/result.tsx (permalink page)
// and routes/home.tsx (the labeled EXAMPLE on the homepage).

import type { LookupResult } from '@released/core';
import { raw } from 'hono/html';
import { permalinkPathForInput } from '../paths.js';

export type ResultCardProps = {
  result: LookupResult;
  /** When true, renders with dashed border + tinted bg + EXAMPLE caption. */
  asExample?: boolean;
  publicBaseUrl: string;
};

export function ResultCard({ result, asExample, publicBaseUrl }: ResultCardProps) {
  // CRITICAL distinction: partial state (algorithm timed out) ≠ "not yet released"
  // (algorithm completed, found no containing tag). A 2024 kubernetes commit
  // hitting the soft deadline should NOT be displayed as "not released."
  //
  // If partial AND we have a best-effort firstRelease, show it with a
  // "could be off by one" caveat (PartialBanner above the result).
  // If partial AND no firstRelease, show the "taking longer" UI.
  if (result.partial && !result.firstRelease) return <PartialResult result={result} />;
  if (!result.firstRelease) return <NotYetReleased result={result} publicBaseUrl={publicBaseUrl} />;
  const r = result.firstRelease;
  const repoDisplay = result.input.repo.projectPath;
  const shortSha = result.canonicalSha.slice(0, 7);
  const perma = `${publicBaseUrl}${permalinkPathForInput(result.input, result.canonicalSha)}`;
  return (
    <>
      {result.partial && <BestEffortBanner result={result} />}
      {result.firstReleaseIsPrerelease && (
        <ProviderPrereleaseBanner tag={r.tag} releaseUrl={r.url} />
      )}
      <div class={`answer ${asExample ? 'example' : ''}`}>
        <div class="answer-hero">
          <div class="answer-label">
            <span class="ship-dot" />
            First released in
          </div>
          <div class="answer-version">
            {/* The version tag is a link to the provider's release page. */}
            <a class="v" href={r.url} style="text-decoration: none; color: inherit;">
              {r.tag}
            </a>
            <span class="ship">SHIPPED</span>
          </div>
          <div class="answer-date">
            <b>{formatDate(r.date)}</b> · shipped {relativeFromCommit(result.canonicalSha, r.date)}
          </div>
          <CopyActions perma={perma} />
        </div>

        <div class="answer-meta">
          <a class="repo" href={result.urls.repo}>
            {repoDisplay}
          </a>
          <a href={result.urls.commit}>commit {shortSha}</a>
        </div>

        {result.releaseNotesHtml && (
          <div class="answer-sec">
            <div class="sec-label">
              Release notes — <a href={r.url}>{r.tag}</a>
            </div>
            {/* raw() — releaseNotesHtml has already been sanitized via micromark
              in core/release-notes.ts. The html`` tagged template was double-
              escaping the result; raw() passes it through correctly. */}
            <div class="notes-html">{raw(result.releaseNotesHtml)}</div>
          </div>
        )}

        {result.alsoIn.length > 0 && (
          <div class="answer-sec alsoin">
            <div class="sec-label">Also contained in</div>
            <div class="versions">
              {result.alsoIn.map((h) => (
                <a key={h.tag} class="v-chip" href={h.url}>
                  {h.tag}
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/** The "Copy" row: badge markdown (primary, live image), Slack mrkdwn, raw link.
 *  The client handler in layout.tsx (formatForCopy) builds each format. All
 *  three work even when not yet released.
 *
 *  Below the buttons sits a live preview that mirrors what each format copies —
 *  the rendered image for "as Badge", the literal string for the rest. It's
 *  populated client-side (the exact strings are built in formatForCopy) and
 *  stays hidden when there's no result payload (e.g. the homepage EXAMPLE). */
function CopyActions({ perma }: { perma: string }) {
  return (
    <div class="copy">
      <div class="answer-actions">
        <span class="share-lbl">Copy</span>
        <button type="button" class="btn-fmt primary" data-copy="badge">
          as Badge
        </button>
        <button type="button" class="btn-fmt" data-copy="slack">
          for Slack
        </button>
        <button type="button" class="btn-fmt" data-copy="link">
          link only
        </button>
        <span class="perma">{perma.replace(/^https?:\/\//, '')}</span>
      </div>
      <div class="copy-preview" data-copy-preview hidden>
        <span class="copy-preview-label" data-copy-preview-label>
          Badge preview
        </span>
        <img class="copy-preview-badge" alt="status badge preview" height="20" hidden />
        <code class="copy-preview-text" />
      </div>
    </div>
  );
}

function BestEffortBanner({ result }: { result: LookupResult }) {
  const tried = result.partial?.candidatesTried ?? 0;
  return (
    <div
      style="
        margin-bottom: 14px;
        padding: 12px 16px;
        border-radius: 8px;
        background: rgba(210,153,34,0.07);
        border: 1px solid var(--warn-dim);
        color: var(--warn);
        font-size: 13.5px;
        line-height: 1.5;
      "
    >
      <b style="color: var(--text);">Best-effort answer.</b> This is a large repo — we found a
      containing release after probing <b>{tried}</b> tags, but ran out of time before
      double-checking whether an even earlier release also contains the commit. The shown release
      almost certainly contains it; the actual "first" could be a few releases earlier in rare
      backport / hotfix cases. Refresh in a moment to continue from where we left off, or use the
      CLI for guaranteed completeness.
    </div>
  );
}

function PartialResult({ result }: { result: LookupResult }) {
  const repoDisplay = result.input.repo.projectPath;
  const sha = result.canonicalSha.slice(0, 7);
  const isGithub = result.input.repo.host === 'github.com';
  const viewLabel = isGithub ? 'View commit on GitHub' : `View commit on ${result.input.repo.host}`;
  const checkedSoFar = result.partial?.candidatesTried ?? 0;
  return (
    <div class="answer">
      <div class="answer-hero">
        <div class="answer-label">Status</div>
        <div class="answer-version">
          <span class="v" style="font-size: 32px; color: var(--warn);">
            Taking longer than usual
          </span>
        </div>
        <div class="answer-date">
          This is a large repo. Checked <b>{checkedSoFar}</b> tags before the time budget ran out.
          Refresh in a moment to continue (the cache will resume from where we left off), or use the
          CLI for guaranteed completion:
        </div>
        <div style="margin-top: 14px; padding: 12px 14px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; font-family: 'Geist Mono', monospace; font-size: 13px; color: var(--text);">
          npx git-released {result.urls.commit}
        </div>
        <div class="answer-actions" style="margin-top: 16px;">
          <a class="btn-fmt primary" href={result.urls.commit} style="text-decoration: none;">
            {viewLabel}
          </a>
        </div>
      </div>
    </div>
  );
}

function NotYetReleased({
  result,
  publicBaseUrl,
}: {
  result: LookupResult;
  publicBaseUrl: string;
}) {
  const perma = `${publicBaseUrl}${permalinkPathForInput(result.input, result.canonicalSha)}`;
  return (
    <div class="answer">
      <div class="answer-hero">
        <div class="answer-label">Status</div>
        <div class="answer-version">
          <span class="v" style="font-size: 36px; color: var(--warn);">
            Not yet released
          </span>
        </div>
        <div class="answer-date">
          <b>On the default branch</b> · commit {result.canonicalSha.slice(0, 7)}
        </div>
        <CopyActions perma={perma} />
        <div class="copy-hint">
          Paste the badge into your PR/MR now — it flips to the version automatically once this
          ships.
        </div>
      </div>
    </div>
  );
}

/** Hint shown above a NotYetReleased answer when the algorithm skipped tags
 *  that LOOK like prereleases (alpha/beta/rc/...). Surfaces the
 *  "Include prereleases" escape hatch. */
export function PrereleaseHint({
  skipped,
  retryHref,
}: {
  skipped: number;
  retryHref: string;
}) {
  return (
    <div
      class="answer"
      style="margin-top: 16px; border-color: var(--warn-dim); background: rgba(210,153,34,0.06);"
    >
      <div class="answer-hero" style="padding: 16px 22px;">
        <div class="answer-label" style="margin-bottom: 6px;">
          Hint
        </div>
        <div style="font-size: 14px; color: var(--text-2);">
          We searched only <b>production releases</b>. {skipped} prerelease tag
          {skipped === 1 ? '' : 's'} (alpha / beta / rc / etc) {skipped === 1 ? 'was' : 'were'}{' '}
          skipped. If you want to know about the first alpha/beta/rc that contained your commit,{' '}
          <a href={retryHref} style="color: var(--accent);">
            include prereleases
          </a>
          .
        </div>
      </div>
    </div>
  );
}

/** Layer-2 banner: GitHub flagged this release as a prerelease but our
 *  tag-name heuristic missed it. The answer is technically correct (this tag
 *  IS the first one containing the commit, sorted by date) but the user asked
 *  for production releases by default and GitHub considers this a prerelease.
 *  The actual first stable release may not exist yet. */
function ProviderPrereleaseBanner({ tag, releaseUrl }: { tag: string; releaseUrl: string }) {
  return (
    <div
      style="
        margin-bottom: 14px;
        padding: 12px 16px;
        border-radius: 8px;
        background: rgba(210,153,34,0.07);
        border: 1px solid var(--warn-dim);
        color: var(--warn);
        font-size: 13.5px;
        line-height: 1.5;
      "
    >
      <b style="color: var(--text);">Heads up: prerelease.</b> GitHub flags{' '}
      <a href={releaseUrl} style="color: inherit; text-decoration: underline;">
        {tag}
      </a>{' '}
      as a prerelease, even though our tag-name heuristic didn't recognize it. The first stable
      release containing this commit may not exist yet — check the project for an unreleased stable
      version, or treat this answer with caution.
    </div>
  );
}

/** Hint shown above the answer when a NotYetReleasedError carried a non-zero
 *  culledTagCount — surfacing the "try strict mode" escape hatch. */
export function StrictHint({
  culled,
  retryHref,
}: {
  culled: number;
  retryHref: string;
}) {
  return (
    <div
      class="answer"
      style="margin-top: 16px; border-color: var(--warn-dim); background: rgba(210,153,34,0.06);"
    >
      <div class="answer-hero" style="padding: 16px 22px;">
        <div class="answer-label" style="margin-bottom: 6px;">
          Hint
        </div>
        <div style="font-size: 14px; color: var(--text-2);">
          {culled} older tag{culled === 1 ? '' : 's'} skipped by the 90-day date cull. If a
          containing tag might have a manually-backdated commit,{' '}
          <a href={retryHref} style="color: var(--accent);">
            re-run in strict mode
          </a>
          .
        </div>
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  // "March 15, 2024"
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function relativeFromCommit(_sha: string, _releaseDate: string): string {
  // The commit date isn't surfaced in the LookupResult itself today.
  // Plan TODO: pass it through and compute "N days after the commit landed."
  return 'recently';
}
