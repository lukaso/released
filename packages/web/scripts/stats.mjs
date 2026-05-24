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
// Run:
//   CLOUDFLARE_ACCOUNT_ID=xxx CLOUDFLARE_API_TOKEN=yyy node scripts/stats.mjs
//   pnpm --filter @released/web stats        # if the env vars are already exported
//
// Counts use sum(_sample_interval) (NOT count()) because Analytics Engine
// samples at high write rates and that column reconstructs true totals.

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
const DATASET = process.env.RELEASED_DATASET || 'released_events';

if (!ACCOUNT_ID || !API_TOKEN) {
  console.error(
    'Missing credentials. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.\n' +
      'The token needs the "Account Analytics: Read" permission.\n' +
      'See the header of this file for setup steps.',
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
    title: 'Errors by type (last 7d)',
    sql: `SELECT blob8 AS error, sum(_sample_interval) AS n
          FROM ${DATASET}
          WHERE blob4 = 'error' AND blob8 != '' AND timestamp > NOW() - INTERVAL '7' DAY
          GROUP BY error ORDER BY n DESC`,
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
