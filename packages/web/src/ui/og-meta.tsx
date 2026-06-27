// OG <meta> tag generator (CP1, D20→D34).
// Emits og:title / og:description / og:image pointing at the web-og Worker.

import type { LookupResult, RepoRef } from '@released/core';
import { OG_TEMPLATE_VERSION } from '@released/core';

export type OgMetaInput = {
  ogBaseUrl: string;
  publicUrl: string;
  result: LookupResult | null;
  /** Caption used when result is null/loading (Slackbot deferred case). */
  fallbackTitle?: string;
  /** Pre-built og:image URL that wins over the result-derived one. Used by the
   *  bot-deferred path (#53): no result yet, but the repo + sha are known from
   *  the route params, so we can still point at the dynamic per-commit card. */
  imageOverride?: string;
};

/** Build the dynamic web-og image URL for a commit. GitHub uses the legacy
 *  `/r/:owner/:repo/c/:sha.png` scheme; other providers use the federated
 *  `/h/:host/r/:projectPath/c/:sha.png` scheme (host + projectPath URL-encoded
 *  into single segments, matching the /h/ permalink routes in index.ts). */
function commitImageUrl(host: string, projectPath: string, sha: string, ogBaseUrl: string): string {
  const v = `?v=${OG_TEMPLATE_VERSION}`;
  if (host === 'github.com') {
    const [owner, name] = projectPath.split('/');
    return `${ogBaseUrl}/r/${owner}/${name}/c/${sha}.png${v}`;
  }
  return `${ogBaseUrl}/h/${encodeURIComponent(host)}/r/${encodeURIComponent(projectPath)}/c/${sha}.png${v}`;
}

/** Build the OG image URL for a resolved result. A null result renders the
 *  neutral placeholder. */
export function ogImageUrl(result: LookupResult | null, ogBaseUrl: string): string {
  if (!result) return `${ogBaseUrl}/placeholder.png?v=${OG_TEMPLATE_VERSION}`;
  const { host, projectPath } = result.input.repo;
  return commitImageUrl(host, projectPath, shortSha(result.canonicalSha), ogBaseUrl);
}

/** Build the dynamic per-commit OG image URL straight from route params, with no
 *  resolved result (#53, the bot-deferred path). Produces the same URL a
 *  resolved result of the same commit would; web-og resolves the commit itself
 *  and falls back to its own placeholder when it can't. */
export function ogImageUrlForCommit(repo: RepoRef, sha: string, ogBaseUrl: string): string {
  return commitImageUrl(repo.host, repo.projectPath, shortSha(sha), ogBaseUrl);
}

export function OgMeta(props: OgMetaInput) {
  const { ogBaseUrl, publicUrl, result, fallbackTitle, imageOverride } = props;
  const title = result?.firstRelease
    ? `${result.firstRelease.tag} — shipped ${shortDate(result.firstRelease.date)}`
    : (fallbackTitle ?? 'released');
  const desc = result
    ? `${shortSha(result.canonicalSha)} in ${result.input.repo.projectPath}`
    : 'Find the first release that contains a commit.';
  const imgUrl = imageOverride ?? ogImageUrl(result, ogBaseUrl);
  return (
    <>
      <meta property="og:type" content="website" />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={desc} />
      <meta property="og:image" content={imgUrl} />
      <meta property="og:url" content={publicUrl} />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={desc} />
      <meta name="twitter:image" content={imgUrl} />
    </>
  );
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function shortDate(iso: string): string {
  return iso.slice(0, 10);
}
