// Output formatters for the CLI.
//
// Three formats: human (default — TTY-friendly), json (--json), slack (--slack).

import type { LookupResult } from '@released/core';

const PERMA_BASE = 'https://released.blabberate.com';

export type FormatKind = 'human' | 'json' | 'slack' | 'markdown';

/** Render a result for the chosen output format. */
export function formatResult(result: LookupResult, kind: FormatKind): string {
  switch (kind) {
    case 'json':
      return JSON.stringify(result, null, 2);
    case 'slack':
      return formatSlack(result);
    case 'markdown':
      return formatMarkdown(result);
    default:
      return formatHuman(result);
  }
}

function formatHuman(r: LookupResult): string {
  if (r.partial) {
    return `(taking longer than usual — try again, or use --json for partial state)`;
  }
  if (!r.firstRelease) {
    return 'Not yet released — on the default branch.';
  }
  const lines: string[] = [];
  lines.push('');
  lines.push(`  First released in  ${r.firstRelease.tag}`);
  lines.push(`            on date  ${formatDate(r.firstRelease.date)}`);
  lines.push(`              commit  ${shortSha(r.canonicalSha)}`);
  if (r.alsoIn.length > 0) {
    lines.push(`             also in  ${r.alsoIn.map((h) => h.tag).join(', ')}`);
  }
  lines.push(`           permalink  ${permalink(r)}`);
  if (r.rateLimit) {
    lines.push(``);
    lines.push(
      `  (GitHub API: ${r.rateLimit.remaining}/${r.rateLimit.limit} remaining, resets at ${formatDate(
        new Date(r.rateLimit.resetAt * 1000).toISOString(),
      )})`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function formatSlack(r: LookupResult): string {
  if (!r.firstRelease) return 'Not yet released — on the default branch.';
  // Slack mrkdwn dialect: *bold*, _italic_, <url|text>
  const repo = r.input.repo.projectPath;
  return [
    `*${r.firstRelease.tag}* shipped ${formatDate(r.firstRelease.date)} contains \`${shortSha(r.canonicalSha)}\` in \`${repo}\``,
    `<${permalink(r)}|see details>`,
  ].join(' · ');
}

function formatMarkdown(r: LookupResult): string {
  if (!r.firstRelease) return '⏳ **Not yet released** — on the default branch.';
  const lines: string[] = [];
  lines.push(
    `✅ \`${shortSha(r.canonicalSha)}\` is first released in [**${r.firstRelease.tag}**](${r.firstRelease.url}) (${formatDate(
      r.firstRelease.date,
    )})`,
  );
  if (r.alsoIn.length > 0) {
    lines.push(`Also in: ${r.alsoIn.map((h) => `\`${h.tag}\``).join(', ')}`);
  }
  lines.push(`[See on released.blabberate.com](${permalink(r)})`);
  return lines.join('\n');
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function formatDate(iso: string): string {
  // YYYY-MM-DD for the human eye.
  return iso.slice(0, 10);
}

function permalink(r: LookupResult): string {
  const sha = shortSha(r.canonicalSha);
  if (r.input.repo.host === 'github.com') {
    return `${PERMA_BASE}/r/${r.input.repo.projectPath}/c/${sha}`;
  }
  return `${PERMA_BASE}/h/${r.input.repo.host}/r/${encodeURIComponent(r.input.repo.projectPath)}/c/${sha}`;
}
