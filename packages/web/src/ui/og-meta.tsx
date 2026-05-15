// OG <meta> tag generator (CP1, D20→D34).
// Emits og:title / og:description / og:image pointing at the web-og Worker.

import type { LookupResult } from '@released/core';
import { OG_TEMPLATE_VERSION } from '@released/core';

export type OgMetaInput = {
  ogBaseUrl: string;
  publicUrl: string;
  result: LookupResult | null;
  /** Caption used when result is null/loading (Slackbot deferred case). */
  fallbackTitle?: string;
};

export function OgMeta(props: OgMetaInput) {
  const { ogBaseUrl, publicUrl, result, fallbackTitle } = props;
  const title = result?.firstRelease
    ? `${result.firstRelease.tag} — shipped ${shortDate(result.firstRelease.date)}`
    : fallbackTitle ?? 'released';
  const desc = result
    ? `${shortSha(result.canonicalSha)} in ${result.input.repo.owner}/${result.input.repo.repo}`
    : 'Find the first release that contains a commit.';
  const imgUrl = result
    ? `${ogBaseUrl}/r/${result.input.repo.owner}/${result.input.repo.repo}/c/${shortSha(result.canonicalSha)}.png?v=${OG_TEMPLATE_VERSION}`
    : `${ogBaseUrl}/placeholder.png?v=${OG_TEMPLATE_VERSION}`;
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
