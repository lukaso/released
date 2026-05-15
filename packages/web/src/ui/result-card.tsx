// Shared result-card rendering. Used by routes/result.tsx (permalink page)
// and routes/home.tsx (the labeled EXAMPLE on the homepage).

import { raw } from 'hono/html';
import type { LookupResult } from '@released/core';

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
  if (!result.firstRelease) return <NotYetReleased result={result} />;
  const r = result.firstRelease;
  const owner = result.input.repo.owner;
  const repoName = result.input.repo.repo;
  const repo = `${owner}/${repoName}`;
  const shortSha = result.canonicalSha.slice(0, 7);
  const perma = `${publicBaseUrl}/r/${owner}/${repoName}/c/${shortSha}`;
  // GitHub URL for the original commit — uses full SHA for unambiguous link.
  const commitUrl = `https://github.com/${owner}/${repoName}/commit/${result.canonicalSha}`;
  // r.url is already the GitHub release URL.
  return (
    <>
      {result.partial && <BestEffortBanner result={result} />}
      <div class={`answer ${asExample ? 'example' : ''}`}>
      <div class="answer-hero">
        <div class="answer-label">
          <span class="ship-dot" />
          First released in
        </div>
        <div class="answer-version">
          {/* The version tag is a link to the GitHub release. */}
          <a class="v" href={r.url} style="text-decoration: none; color: inherit;">
            {r.tag}
          </a>
          <span class="ship">SHIPPED</span>
        </div>
        <div class="answer-date">
          <b>{formatDate(r.date)}</b> · shipped {relativeFromCommit(result.canonicalSha, r.date)}
        </div>
        <div class="answer-actions">
          <span class="share-lbl">Copy</span>
          <button class="btn-fmt primary" data-copy="markdown">as Markdown</button>
          <button class="btn-fmt" data-copy="slack">for Slack</button>
          <button class="btn-fmt" data-copy="link">link only</button>
          <span class="perma">{perma.replace(/^https?:\/\//, '')}</span>
        </div>
      </div>

      <div class="answer-meta">
        <a class="repo" href={`https://github.com/${owner}/${repoName}`}>
          {repo}
        </a>
        <a href={commitUrl}>commit {shortSha}</a>
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
              <a class="v-chip" href={h.url}>
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
  const owner = result.input.repo.owner;
  const repoName = result.input.repo.repo;
  const sha = result.canonicalSha.slice(0, 7);
  const commitUrl = `https://github.com/${owner}/${repoName}/commit/${result.canonicalSha}`;
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
          Refresh in a moment to continue (the cache will resume from where we left off), or use
          the CLI for guaranteed completion:
        </div>
        <div
          style="margin-top: 14px; padding: 12px 14px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; font-family: 'Geist Mono', monospace; font-size: 13px; color: var(--text);"
        >
          npx released {owner}/{repoName} {sha}
        </div>
        <div class="answer-actions" style="margin-top: 16px;">
          <a class="btn-fmt primary" href={commitUrl} style="text-decoration: none;">
            View commit on GitHub
          </a>
        </div>
      </div>
    </div>
  );
}

function NotYetReleased({ result }: { result: LookupResult }) {
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
      style="margin-bottom: 16px; border-color: var(--warn-dim); background: rgba(210,153,34,0.06);"
    >
      <div class="answer-hero" style="padding: 16px 22px;">
        <div class="answer-label" style="margin-bottom: 6px;">Hint</div>
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
      style="margin-bottom: 16px; border-color: var(--warn-dim); background: rgba(210,153,34,0.06);"
    >
      <div class="answer-hero" style="padding: 16px 22px;">
        <div class="answer-label" style="margin-bottom: 6px;">Hint</div>
        <div style="font-size: 14px; color: var(--text-2);">
          {culled} older tag{culled === 1 ? '' : 's'} skipped by the 90-day date cull.
          If a containing tag might have a manually-backdated commit,{' '}
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
