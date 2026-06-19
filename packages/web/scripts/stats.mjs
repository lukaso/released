#!/usr/bin/env node
// Usage dashboard for the `released` web Worker, querying the Cloudflare Workers
// Analytics Engine SQL API. Server-side data points are written from
// src/analytics.ts (one per request); this reads them back.
//
// Setup (one time):
//   1. Account ID: Cloudflare dashboard → Workers & Pages → right sidebar.
//   2. API token: dashboard → My Profile → API Tokens → Create Token →
//      "Create Custom Token" with permission **Account · Account Analytics · Read**.
//
// Credentials are read from the environment OR from packages/web/.dev.vars
// (env wins). Put these two lines in .dev.vars so `pnpm stats` just works:
//   CLOUDFLARE_ACCOUNT_ID=...
//   CLOUDFLARE_ANALYTICS_TOKEN=...
//
// Run:
//   pnpm --filter @released/web stats
//   CLOUDFLARE_ACCOUNT_ID=xxx CLOUDFLARE_ANALYTICS_TOKEN=yyy node scripts/stats.mjs
//
// Counts use sum(_sample_interval) (NOT count()) because Analytics Engine
// samples at high write rates and that column reconstructs true totals.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Parse packages/web/.dev.vars (dotenv-style KEY=value) so credentials don't
// have to be exported. The Worker reads this file via wrangler; we reuse it as a
// convenient local secret store. Real environment variables take precedence.
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

const ACCOUNT_ID = cred('CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID');
const API_TOKEN = cred('CLOUDFLARE_ANALYTICS_TOKEN', 'CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN');
const DATASET = cred('RELEASED_DATASET') || 'released_events';

if (!ACCOUNT_ID || !API_TOKEN) {
  const missing = [
    ACCOUNT_ID ? null : 'CLOUDFLARE_ACCOUNT_ID',
    API_TOKEN ? null : 'CLOUDFLARE_ANALYTICS_TOKEN',
  ].filter(Boolean);
  console.error(
    `Missing credentials: ${missing.join(', ')}.\n` +
      'Add them to packages/web/.dev.vars (or export them). The token needs the\n' +
      '"Account · Account Analytics · Read" permission. See this file’s header.',
  );
  process.exit(1);
}

const SQL_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/analytics_engine/sql`;

/** Run one SQL query against the Analytics Engine. Returns { columns, rows }. */
async function query(sql) {
  const res = await fetch(SQL_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    body: sql,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response: ${text.slice(0, 500)}`);
  }
  const data = json.data ?? [];
  const columns = (json.meta ?? []).map((m) => m.name);
  // Fall back to the keys of the first row if meta is absent.
  const cols = columns.length ? columns : data[0] ? Object.keys(data[0]) : [];
  return { columns: cols, rows: data };
}

/** Render rows (array of objects) as an aligned text table. */
function table(columns, rows) {
  if (!rows.length) return '  (no data)';
  const widths = columns.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)),
  );
  const line = (cells) => '  ' + cells.map((v, i) => String(v).padEnd(widths[i])).join('  ');
  const header = line(columns);
  const rule = '  ' + widths.map((w) => '-'.repeat(w)).join('  ');
  return [header, rule, ...rows.map((r) => line(columns.map((c) => r[c] ?? '')))].join('\n');
}

const SECTIONS = [
  {
    title: 'Lookups per day (last 30d)',
    sql: `SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day,
                 sum(_sample_interval) AS lookups
          FROM ${DATASET}
          WHERE blob1 IN ('result', 'pr', 'api_lookup')
            AND timestamp > NOW() - INTERVAL '30' DAY
          GROUP BY day ORDER BY day`,
  },
  {
    title: 'Requests by type (last 7d)',
    sql: `SELECT blob1 AS event, sum(_sample_interval) AS n
          FROM ${DATASET}
          WHERE timestamp > NOW() - INTERVAL '7' DAY
          GROUP BY event ORDER BY n DESC`,
  },
  {
    title: 'Provider split (last 30d)',
    sql: `SELECT blob2 AS host, sum(_sample_interval) AS n
          FROM ${DATASET}
          WHERE blob2 != '' AND timestamp > NOW() - INTERVAL '30' DAY
          GROUP BY host ORDER BY n DESC`,
  },
  {
    title: 'Top repos looked up (last 30d)',
    sql: `SELECT blob2 AS host, blob3 AS repo, sum(_sample_interval) AS n
          FROM ${DATASET}
          WHERE blob3 != '' AND timestamp > NOW() - INTERVAL '30' DAY
          GROUP BY host, repo ORDER BY n DESC LIMIT 25`,
  },
  {
    title: 'Badge usage — fetches + distinct repos (last 30d)',
    sql: `SELECT sum(_sample_interval) AS badge_fetches,
                 count(DISTINCT blob3) AS repos_with_badge
          FROM ${DATASET}
          WHERE blob1 = 'badge' AND timestamp > NOW() - INTERVAL '30' DAY`,
  },
  {
    title: 'Top badge repos (last 30d)',
    sql: `SELECT blob2 AS host, blob3 AS repo, sum(_sample_interval) AS fetches
          FROM ${DATASET}
          WHERE blob1 = 'badge' AND blob3 != '' AND timestamp > NOW() - INTERVAL '30' DAY
          GROUP BY host, repo ORDER BY fetches DESC LIMIT 25`,
  },
  {
    // Copying a badge/link is the seeding action behind the viral loop — someone
    // grabbing the snippet to embed on a repo. Written by POST /api/event
    // (src/routes/event.ts); blob10 is the share format.
    title: 'Copies by format (last 30d)',
    sql: `SELECT blob10 AS format, sum(_sample_interval) AS n
          FROM ${DATASET}
          WHERE blob1 = 'copy' AND timestamp > NOW() - INTERVAL '30' DAY
          GROUP BY format ORDER BY n DESC`,
  },
  {
    title: 'Top copied repos (last 30d)',
    sql: `SELECT blob2 AS host, blob3 AS repo, blob10 AS format,
                 sum(_sample_interval) AS copies
          FROM ${DATASET}
          WHERE blob1 = 'copy' AND blob3 != '' AND timestamp > NOW() - INTERVAL '30' DAY
          GROUP BY host, repo, format ORDER BY copies DESC LIMIT 25`,
  },
  {
    // UI searches ride the `redirect` event (the /lookup form round-trips us).
    // A failed parse is tagged outcome=invalid; everything else resolved.
    title: 'Searches — valid vs invalid (last 7d)',
    sql: `SELECT if(blob4 = 'invalid', 'invalid', 'valid') AS search,
                 sum(_sample_interval) AS n
          FROM ${DATASET}
          WHERE blob1 = 'redirect' AND timestamp > NOW() - INTERVAL '7' DAY
          GROUP BY search ORDER BY n DESC`,
  },
  {
    title: 'Badge cache-hit rate (last 7d)',
    sql: `SELECT blob5 AS cache, sum(_sample_interval) AS n
          FROM ${DATASET}
          WHERE blob1 = 'badge' AND blob5 != '' AND timestamp > NOW() - INTERVAL '7' DAY
          GROUP BY cache ORDER BY n DESC`,
  },
  {
    title: 'Outcome mix (last 7d)',
    sql: `SELECT blob4 AS outcome, sum(_sample_interval) AS n
          FROM ${DATASET}
          WHERE blob4 != '' AND timestamp > NOW() - INTERVAL '7' DAY
          GROUP BY outcome ORDER BY n DESC`,
  },
  {
    // upstream_status (double3) is the provider's HTTP status — distinguishes a
    // 5xx outage from a 429 rate-limit from a 0 (no upstream call / pre-fix row).
    // double1 (the worker→client status) hides this.
    title: 'Errors by host + type + upstream status (last 7d)',
    sql: `SELECT blob2 AS host, blob8 AS error, double3 AS upstream_status,
                 sum(_sample_interval) AS n
          FROM ${DATASET}
          WHERE blob4 = 'error' AND blob8 != '' AND timestamp > NOW() - INTERVAL '7' DAY
          GROUP BY host, error, upstream_status ORDER BY n DESC`,
  },
  {
    // blob11 is the referring host (hostname only). The honest read on
    // organic-vs-self: a search engine / news.ycombinator.com / reddit referer
    // is organic discovery; gitlab.gnome.org etc. is someone viewing a page
    // where a link/badge lives; '' (excluded here) is direct / CLI / a proxy
    // that stripped the referer. Partial signal — embedded badge images are
    // often proxied — but result-page + search/HN referers come through clean.
    title: 'Referrers — where traffic comes from (last 30d)',
    sql: `SELECT blob11 AS referer, sum(_sample_interval) AS n
          FROM ${DATASET}
          WHERE blob11 != '' AND timestamp > NOW() - INTERVAL '30' DAY
          GROUP BY referer ORDER BY n DESC LIMIT 25`,
  },
  {
    title: 'Audience — human vs unfurl bot (last 7d)',
    sql: `SELECT blob7 AS audience, sum(_sample_interval) AS n
          FROM ${DATASET}
          WHERE blob7 != '' AND timestamp > NOW() - INTERVAL '7' DAY
          GROUP BY audience ORDER BY n DESC`,
  },
  {
    title: 'Cache-miss lookup latency, ms (last 7d)',
    sql: `SELECT avg(double2) AS avg_ms,
                 quantileWeighted(0.95)(double2, _sample_interval) AS p95_ms,
                 max(double2) AS max_ms
          FROM ${DATASET}
          WHERE blob5 = 'miss' AND blob1 IN ('result', 'pr', 'api_lookup')
            AND timestamp > NOW() - INTERVAL '7' DAY`,
  },
];

console.log(`\nreleased — usage (dataset: ${DATASET})\n${'='.repeat(48)}`);
for (const { title, sql } of SECTIONS) {
  console.log(`\n${title}`);
  try {
    const { columns, rows } = await query(sql);
    console.log(table(columns, rows));
  } catch (err) {
    console.log(`  ! query failed: ${err.message}`);
  }
}
console.log('');
