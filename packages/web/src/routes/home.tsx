// GET / — the homepage. Empty state: input + ONE pre-rendered EXAMPLE result.
// Same page in resolved state lives at /r/:o/:r/c/:sha (routes/result.tsx).

import { KNOWN_PROJECTS } from '@released/core';
import type { Context } from 'hono';
import { ogBaseUrl, publicBaseUrl } from '../env.js';
import { EXAMPLE_LIVE_URL, EXAMPLE_RESULT } from '../example.js';
import { makeNonce, securityHeaders } from '../security.js';
import { Layout } from '../ui/layout.js';
import { ResultCard } from '../ui/result-card.js';

export async function homeRoute(c: Context): Promise<Response> {
  const env = c.env as import('../env.js').Env;
  const req = c.req.raw;
  const nonce = makeNonce();
  const pubBase = publicBaseUrl(env, req);
  const ogBase = ogBaseUrl(env, req);

  // When the /lookup form-fallback couldn't parse, it redirects here with
  // ?bad=<original-input>&reason=<error-kind>. Surface a tailored message.
  const bad = c.req.query('bad') ?? '';
  const reason = c.req.query('reason') ?? '';
  const errorMsg = bad ? messageForReason(reason, bad) : null;

  const html = (
    <Layout
      title="released — is your commit shipped?"
      nonce={nonce}
      ogBaseUrl={ogBase}
      publicUrl={pubBase}
      ogResult={null}
      ogFallbackTitle="released — find the first release that contains a commit"
    >
      <Nav />
      <main>
        <h1 class="headline">Is your commit shipped?</h1>
        <p class="orient">
          Paste a commit, SHA, or merged PR — get back the first release that contains it.
        </p>

        {errorMsg && (
          <ErrorBanner message={errorMsg} bad={bad} reason={reason} />
        )}

        <form method="get" action="/lookup" data-loading-form>
          <label class="field-label" for="q">
            Commit URL, SHA, or pull/merge request
          </label>
          <div class="searchbox">
            <input
              id="q"
              name="q"
              type="text"
              value={bad}
              placeholder="github.com/o/r/commit/abc1234  ·  owner/repo abc1234  ·  o/r#PR  ·  gitlab.gnome.org/.../-/merge_requests/N"
              autocomplete="off"
              spellcheck={false}
              required
            />
            <button type="submit">
              <span class="btn-label">Is it released? →</span>
              <span class="btn-loading" aria-hidden="true">
                Looking up
                <span class="dots" />
              </span>
            </button>
          </div>
        </form>
        <ProjectChips />

        <div class="example-section">
          <div class="example-header">
            <span class="example-tag">EXAMPLE</span>
            <span class="example-caption">
              Real result: a lookup for{' '}
              <a
                href={EXAMPLE_LIVE_URL}
                style="color: var(--text); text-decoration: underline; text-underline-offset: 3px;"
              >
                <b>honojs/hono @ f82aba8</b>
              </a>
              .{' '}
              <a
                href={`/lookup?q=${encodeURIComponent(EXAMPLE_LIVE_URL)}`}
                style="color: var(--accent);"
              >
                Run it yourself →
              </a>
            </span>
          </div>
          <ResultCard result={EXAMPLE_RESULT} asExample publicBaseUrl={pubBase} />
        </div>
      </main>
      <footer>
        <a href="/how-it-works">how it works</a>
        <a href="https://www.npmjs.com/package/git-released">CLI</a>
        <a href="https://github.com/lukaso/released">GitHub</a>
      </footer>
    </Layout>
  );

  return new Response(`<!DOCTYPE html>${html.toString()}`, {
    // Tell the browser/intermediaries not to cache an error-state page; otherwise
    // the next request to / could serve the cached error UI.
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': errorMsg ? 'no-store' : 'public, max-age=300',
      ...securityHeaders(nonce, ogBase),
    },
  });
}

function Nav() {
  return (
    <nav>
      <div class="wordmark">
        <span class="dot" />
        released
      </div>
      <div class="nav-links">
        <a href="/how-it-works">Docs</a>
        <a href="https://www.npmjs.com/package/git-released">CLI</a>
        <a href="https://github.com/lukaso/released">GitHub</a>
      </div>
    </nav>
  );
}

function ErrorBanner({
  message,
  bad,
  reason,
}: {
  message: string;
  bad: string;
  reason: string;
}) {
  return (
    <div
      role="alert"
      style="
        margin-bottom: 18px;
        padding: 14px 16px;
        border-radius: 8px;
        background: rgba(210,153,34,0.08);
        border: 1px solid var(--warn-dim);
        color: var(--warn);
      "
    >
      <div style="font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 6px;">
        Couldn't parse that
      </div>
      <div style="font-size: 14px; color: var(--text); line-height: 1.5;">{message}</div>
      {bad && (
        <div style="margin-top: 8px; font-family: 'Geist Mono', monospace; font-size: 12px; color: var(--text-3); word-break: break-all;">
          input: {bad}
        </div>
      )}
      {reason === 'bare_sha' && (
        <div class="error-chips">
          <ProjectChips inErrorBanner />
        </div>
      )}
    </div>
  );
}

/**
 * Popular projects chip row. Each chip is a <button> carrying the alias in
 * data-alias; the delegated click handler in layout.tsx inserts the alias
 * (and preserves any SHA-shape input) into the search box and refocuses it.
 * Rendered twice: once below the search form as the main discovery surface,
 * and again inside the bare-SHA error banner so the user can recover in one
 * click. The two instances share the same handler via event delegation.
 */
function ProjectChips({ inErrorBanner = false }: { inErrorBanner?: boolean }) {
  const labelId = inErrorBanner ? 'popular-projects-label-err' : 'popular-projects-label';
  return (
    <section class={inErrorBanner ? '' : 'projects-section'} aria-labelledby={labelId}>
      <span id={labelId} class="projects-label">
        Popular projects
      </span>
      <div class="projects-row">
        {KNOWN_PROJECTS.map((p) => (
          <button type="button" class="project-chip" data-alias={p.alias}>
            {p.displayName}
          </button>
        ))}
      </div>
      {!inErrorBanner && (
        <p class="projects-hint">…or paste any GitHub / GitLab URL above.</p>
      )}
    </section>
  );
}

function messageForReason(reason: string, bad: string): string {
  switch (reason) {
    case 'unsupported_host':
    case 'non_github_url':
      // List supported hosts AND the env-var path so users can self-serve.
      return (
        "I don't recognize that host. Supported: github.com, gitlab.com, gitlab.gnome.org, " +
        'gitlab.freedesktop.org, salsa.debian.org, invent.kde.org, gitlab.kitware.com. ' +
        'If yours is a self-hosted GitLab, the admin can add it via the EXTRA_GITLAB_HOSTS env var.'
      );
    case 'bare_sha':
      // The input WAS a valid SHA, just no repo. Be specific and actionable —
      // show the exact shorthand they should paste.
      return `That looks like a SHA, but I need a repo too. Try \`owner/repo ${bad}\` (space-separated) or \`owner/repo@${bad}\` (compact).`;
    case 'invalid_input':
    case 'invalid':
      if (/^(?:https?:\/\/)?github\.com\//i.test(bad)) {
        return "That's a GitHub URL but not a shape I recognize. I read /commit/{sha}, /commits/{sha}, /blob|tree|blame|raw/{sha}/..., and /pull/{N}. If you have just the SHA, paste it on its own with the repo (e.g. owner/repo@sha).";
      }
      if (/^(?:https?:\/\/)?gitlab/i.test(bad)) {
        return "That's a GitLab URL but not a shape I recognize. I read /-/commit/{sha}, /-/commits/{sha}, /-/blob|tree|blame|raw/{sha}/..., and /-/merge_requests/{N}.";
      }
      return 'I expected a commit URL, SHA (7-40 hex), PR/MR URL or `owner/repo#PR` shorthand. Try one of the formats in the placeholder or pick the example below.';
    default:
      return `Couldn't parse the input (${reason}). Try one of the formats in the placeholder.`;
  }
}
