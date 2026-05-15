// The pre-rendered EXAMPLE result on the homepage (D34). Real, verified data —
// click the "permalink" link on the rendered card and you'll see the same
// result for real. Picked because:
//   - honojs/hono is a small, well-known dev tool (audience overlap with this site)
//   - The commit is several releases old, so the result is stable
//   - Real release notes give the result-card visual weight
// Refresh by running:
//   curl -s -X POST -H 'content-type: application/json' \
//     -d '{"input":"honojs/hono","ref":"f82aba8e8ea45d56199e751cee6ea7c067bcd176"}' \
//     http://localhost:8787/api/lookup | jq '.result'

import type { LookupResult } from '@released/core';

export const EXAMPLE_RESULT: LookupResult = {
  input: {
    kind: 'commit',
    repo: { owner: 'honojs', repo: 'hono' },
    sha: 'f82aba8e8ea45d56199e751cee6ea7c067bcd176',
  },
  canonicalSha: 'f82aba8e8ea45d56199e751cee6ea7c067bcd176',
  firstRelease: {
    tag: 'v4.12.11',
    sha: '2c403c67eb3d7be15aaa9e74ec74d2dcb4b4b4d2',
    date: '2026-04-06T16:37:19+09:00',
    url: 'https://github.com/honojs/hono/releases/tag/v4.12.11',
  },
  alsoIn: [
    { tag: 'v4.12.12', sha: 'c37ba26da9709ad03b803d1972773ed864b7e60d', date: '2026-04-07T13:12:57+09:00', url: 'https://github.com/honojs/hono/releases/tag/v4.12.12' },
    { tag: 'v4.12.13', sha: '3779927c17201dc6bfd20697f0e1ec65407da779', date: '2026-04-15T14:27:01+09:00', url: 'https://github.com/honojs/hono/releases/tag/v4.12.13' },
    { tag: 'v4.12.14', sha: 'cf2d2b7edcf07adef2db7614557f4d7f9e2be7ba', date: '2026-04-15T15:13:47+09:00', url: 'https://github.com/honojs/hono/releases/tag/v4.12.14' },
    { tag: 'v4.12.15', sha: 'f774f8df49e7ec7e205f15c5076a37132c515ebf', date: '2026-04-24T15:50:59+09:00', url: 'https://github.com/honojs/hono/releases/tag/v4.12.15' },
    { tag: 'v4.12.16', sha: '90d4182aabd328e2ec6af3f25ec62ddc574ad8cb', date: '2026-04-30T18:10:27+09:00', url: 'https://github.com/honojs/hono/releases/tag/v4.12.16' },
  ],
  releaseNotesHtml:
    "<h2>What's Changed</h2>\n<ul>\n<li>feat(css): add classNameSlug option to createCssContext by @flow-pie in https://github.com/honojs/hono/pull/4834</li>\n</ul>\n<h2>New Contributors</h2>\n<ul>\n<li>@flow-pie made their first contribution in https://github.com/honojs/hono/pull/4834</li>\n</ul>\n<p><strong>Full Changelog</strong>: https://github.com/honojs/hono/compare/v4.12.10...v4.12.11</p>",
  rateLimit: null,
};

/** The full GitHub commit URL for the example. Surfaced on the homepage as a
 *  "try this yourself" link so users can verify the example is real. */
export const EXAMPLE_LIVE_URL =
  'https://github.com/honojs/hono/commit/f82aba8e8ea45d56199e751cee6ea7c067bcd176';
