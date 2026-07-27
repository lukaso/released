#!/usr/bin/env node
// Cache-warming tool for the `released` web Worker.
//
// Bumping `CACHE_NS` (packages/core/src/types.ts) re-keys every cache entry, so
// the whole edge cache goes cold on the next deploy and every lookup recomputes
// — a P50 latency regression for the high-traffic repos until they re-warm.
// This script re-warms them on demand: it picks the top GitHub repos (by real
// lookup volume from Analytics Engine, or an explicit list), resolves each
// repo's latest release-tag commit (a commit the Worker will cache as a 200 —
// default-branch HEAD is usually unreleased and returns an uncached 404), and
// POSTs it to POST /api/lookup so the Worker recomputes-and-caches it now
// rather than on a user's request.
//
// Why the Worker and not a direct cache write: the Worker owns the cache keys
// (sha256 over [CACHE_NS, kind, …], packages/core/src/cache.ts) and the
// recomputation. Hitting the public route warms the exact same keys + code path
// a real visitor does, so it can't drift from what the Worker writes itself.
//
// Per-colo caveat (read this): the Worker stores results in Cloudflare's
// Cache API (`caches.default`), which is PER-COLO. A request from this machine
// is served by the single colo nearest it, so this run warms THAT colo only —
// not every edge location. The top repos re-warm everywhere via organic traffic
// anyway; this just accelerates re-warming for the colo(s) you run it from. For
// broader coverage, run it from additional regions.
//
// Rate limits: each warm triggers the Worker to fetch the repo's tags from
// GitHub. If the Worker has its GITHUB_TOKEN secret set (README one-time setup,
// 5000 req/hr) the burst is fine. If not, GitHub's 60/hr anonymous limit is
// shared with real users — lower --concurrency / raise --delay, and expect some
// 429s (the Worker degrades to a recovery card, never a crash). This script also
// makes 2 GitHub REST calls per repo (releases/latest + commits/{tag}) to pick
// the warm target; those are authenticated via GITHUB_TOKEN/GH_TOKEN when set.
//
// Usage:
//   pnpm --filter @released/web warm                       # top 100 from AE
//   pnpm --filter @released/web warm -- --limit 25 --dry-run
//   pnpm --filter @released/web warm -- --repos honojs/hono,facebook/react
//   node scripts/warm-cache.mjs --base http://localhost:8787 --repos honojs/hono
//
// Credentials (AE is only needed when deriving the top-repo list):
//   CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_ANALYTICS_TOKEN in packages/web/.dev.vars
//   (same as `pnpm stats`). GITHUB_TOKEN/GH_TOKEN (env or .dev.vars) is optional
//   but recommended for the release-tag SHA fetch.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── pure helpers (unit-tested in test/warm-cache.test.mjs) ──────────────────

/** Parse a comma-separated "owner/repo" list into a trimmed, de-emptied array. */
export function parseReposArg(arg) {
  if (!arg) return [];
  return arg
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Split "owner/name" on the first slash. Throws if there's no slash. */
export function splitOwnerRepo(repo) {
  const idx = repo.indexOf('/');
  if (idx <= 0) throw new Error(`expected "owner/name", got "${repo}"`);
  return { owner: repo.slice(0, idx), name: repo.slice(idx + 1) };
}

/** Build the Analytics Engine SQL for the top GitHub repos by lookup volume. */
export function buildTopReposSql({ dataset = 'released_events', days = 30, limit = 100 } = {}) {
  return `SELECT blob3 AS repo, sum(_sample_interval) AS n
FROM ${dataset}
WHERE blob2 = 'github.com'
  AND blob3 != ''
  AND blob12 != '1'
  AND blob1 IN ('result', 'pr', 'api_lookup', 'api_bulk')
  AND timestamp > NOW() - INTERVAL '${days}' DAY
GROUP BY repo
ORDER BY n DESC
LIMIT ${limit}`;
}

/** Build the {input, ref} body POST /api/lookup expects (see src/example.ts). */
export function buildWarmPayload(repo, sha) {
  return { input: repo, ref: sha };
}

// ── credentials (same source + pattern as scripts/stats.mjs) ────────────────

function loadDevVars() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const text = readFileSync(join(here, '..', '.dev.vars'), 'utf8');
    const out = {};
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[m[1]] = v;
    }
    return out;
  } catch {
    return {};
  }
}

const devVars = loadDevVars();
const cred = (...names) => {
  for (const n of names) {
    if (process.env[n]) return process.env[n];
    if (devVars[n]) return devVars[n];
  }
  return undefined;
};

function resolveAeCreds() {
  const accountId = cred('CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID');
  const apiToken = cred('CLOUDFLARE_ANALYTICS_TOKEN', 'CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN');
  const dataset = cred('RELEASED_DATASET') || 'released_events';
  if (!accountId || !apiToken) return null;
  return { accountId, apiToken, dataset };
}

// ── I/O ─────────────────────────────────────────────────────────────────────

const DEFAULT_BASE = 'https://released.blabberate.com';

function parseArgs(argv) {
  const opts = {
    base: DEFAULT_BASE,
    limit: 100,
    days: 30,
    repos: null,
    concurrency: 4,
    delay: 0,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      return v;
    };
    switch (a) {
      case '--base':
        opts.base = next();
        break;
      case '--limit':
        opts.limit = Number.parseInt(next(), 10);
        break;
      case '--days':
        opts.days = Number.parseInt(next(), 10);
        break;
      case '--repos':
        opts.repos = next();
        break;
      case '--concurrency':
        opts.concurrency = Number.parseInt(next(), 10);
        break;
      case '--delay':
        opts.delay = Number.parseInt(next(), 10);
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '-h':
      case '--help':
        process.stdout.write(USAGE, 'utf8');
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option: ${a}`);
    }
  }
  return opts;
}

const USAGE = `Warm the released web Worker's edge cache for top GitHub repos.

Usage:
  warm-cache.mjs [options]

Options:
  --base URL        Worker base URL (default: ${DEFAULT_BASE})
  --limit N         Top-N repos from Analytics Engine (default: 100)
  --days N          AE lookback window in days (default: 30)
  --repos LIST      Comma-separated owner/repo list; skips AE (e.g. "a/b,c/d")
  --concurrency N   In-flight warm requests (default: 4)
  --delay MS        Wait this many ms before each dispatch (rate-limit pacing)
  --dry-run         Resolve targets, print them, warm nothing
  -h, --help        Show this help

Credentials (in packages/web/.dev.vars or env):
  CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_ANALYTICS_TOKEN  (AE; only for --limit top-N)
  GITHUB_TOKEN | GH_TOKEN                             (release-tag SHA fetch; optional)
`;

// `dataset` is intentionally NOT a param here: it's baked into the SQL by
// buildTopReposSql(), so this function only needs the auth + endpoint.
async function aeQuery({ accountId, apiToken }, sql) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}` },
    body: sql,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`AE HTTP ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  return json.data ?? [];
}

async function fetchTopRepos(aeCreds, days, limit) {
  const rows = await aeQuery(aeCreds, buildTopReposSql({ dataset: aeCreds.dataset, days, limit }));
  return rows.map((r) => ({ repo: String(r.repo), n: Number(r.n) || 0 }));
}

// Resolve the commit SHA to warm. We pick the LATEST RELEASE TAG's commit, not
// the default-branch HEAD: HEAD is usually newer than any release, so the lookup
// returns `not_yet_released` (a 404 the Worker does NOT cache) and warms nothing
// useful. A release-tag commit is contained by a release → a 200 the Worker
// caches for 30min, warming both the `tags` list and the result.
async function resolveWarmSha(repo, token) {
  const { owner, name } = splitOwnerRepo(repo);
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'released-warm-cache' };
  if (token) headers.authorization = `Bearer ${token}`;
  const relRes = await fetch(`https://api.github.com/repos/${owner}/${name}/releases/latest`, {
    headers,
  });
  if (relRes.status === 404) throw new Error('no releases');
  if (relRes.status === 403 || relRes.status === 429) throw new Error('github rate_limited');
  if (!relRes.ok) throw new Error(`github releases http ${relRes.status}`);
  const tag = (await relRes.json())?.tag_name;
  if (!tag) throw new Error('no tag on latest release');
  const cRes = await fetch(`https://api.github.com/repos/${owner}/${name}/commits/${tag}`, {
    headers,
  });
  if (cRes.status === 403 || cRes.status === 429) throw new Error('github rate_limited');
  if (cRes.status === 404) throw new Error(`commit for ${tag} not found`);
  if (!cRes.ok) throw new Error(`github commit http ${cRes.status}`);
  const sha = (await cRes.json())?.sha;
  if (!sha) throw new Error(`no sha for ${tag}`);
  return sha;
}

/** POST one lookup to the Worker so it recomputes-and-caches the result.
 *  `cacheHit` (from the Worker's response) tells us whether it was already warm. */
async function warmOne(base, repo, sha) {
  const start = Date.now();
  const res = await fetch(`${base}/api/lookup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildWarmPayload(repo, sha)),
  });
  const ms = Date.now() - start;
  let tag = null;
  let cacheHit = null;
  if (res.ok) {
    const json = await res.json().catch(() => null);
    tag = json?.result?.firstRelease?.tag ?? null;
    cacheHit = json?.cacheHit === true;
  }
  return { status: res.status, ms, tag, cacheHit };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Concurrency-limited map that preserves order and never rejects. */
async function pMap(items, concurrency, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => worker()),
  );
  return out;
}

function fmtRepoLine(r) {
  const lookups = r.n ? `  [${r.n}/30d]` : '';
  if (r.error) return `  ✗ ${r.repo}${lookups}  — ${r.error}`;
  if (r.status) {
    if (r.tag) {
      const state = r.cacheHit ? 'already cached' : 'warmed';
      return `  ✓ ${r.repo}${lookups}  → ${r.tag}  (${state}, ${r.ms}ms)`;
    }
    return `  · ${r.repo}${lookups}  http ${r.status}, no release  (${r.ms}ms)`;
  }
  // Dry-run target: no status/latency yet.
  return `  · ${r.repo}${lookups}`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Resolve targets: explicit list, or top-N from Analytics Engine.
  let targets;
  if (opts.repos) {
    targets = parseReposArg(opts.repos).map((repo) => ({ repo }));
  } else {
    const aeCreds = resolveAeCreds();
    if (!aeCreds) {
      console.error(
        'No Analytics Engine credentials (CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_ANALYTICS_TOKEN)\n' +
          'in packages/web/.dev.vars or env. Pass --repos owner/repo,... to warm an explicit list.',
      );
      process.exit(1);
    }
    targets = await fetchTopRepos(aeCreds, opts.days, opts.limit);
  }

  if (!targets.length) {
    console.log('No target repos to warm.');
    return;
  }

  console.log(
    `Warming ${targets.length} repo(s) against ${opts.base}${opts.dryRun ? ' (DRY RUN)' : ''}`,
  );

  if (opts.dryRun) {
    for (const t of targets) console.log(fmtRepoLine(t));
    return;
  }

  const ghToken = cred('GITHUB_TOKEN', 'GH_TOKEN');
  if (!ghToken) {
    console.warn('Warning: no GITHUB_TOKEN/GH_TOKEN — HEAD-SHA fetches are anonymous (60/hr).');
  }

  const startedAt = Date.now();
  const results = await pMap(targets, opts.concurrency, async (t) => {
    if (opts.delay) await sleep(opts.delay);
    let sha;
    try {
      sha = await resolveWarmSha(t.repo, ghToken);
    } catch (err) {
      return { repo: t.repo, n: t.n, error: `sha: ${err.message}` };
    }
    try {
      const r = await warmOne(opts.base, t.repo, sha);
      return { repo: t.repo, n: t.n, sha, ...r };
    } catch (err) {
      return { repo: t.repo, n: t.n, sha, error: `warm: ${err.message}` };
    }
  });

  for (const r of results) console.log(fmtRepoLine(r));

  const warmed = results.filter((r) => !r.error && r.tag && !r.cacheHit).length;
  const cached = results.filter((r) => !r.error && r.cacheHit).length;
  const fail = results.filter((r) => r.error).length;
  console.log(
    `\nDone: ${warmed} warmed, ${cached} already cached, ${fail} failed in ${Date.now() - startedAt}ms.`,
  );
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err?.message ?? String(err));
    process.exit(1);
  });
}
