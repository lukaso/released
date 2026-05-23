// SVG status-badge generator (shields.io "flat" style, self-rendered).
//
// We render the badge ourselves rather than proxying shields.io so visitor
// IPs stay on our edge (same privacy stance as the self-hosted fonts) and the
// badge inherits the project's semantic colors. The SVG is embedded in MR/PR
// markdown as an <img>; GitHub (camo) / GitLab proxy it server-side, so it
// auto-updates on their cache TTL exactly like a CI build badge.

import type { LookupResult } from '@released/core';

/** Semantic badge colors — mirror the design tokens in ui/styles.ts. */
export const BADGE_COLORS = {
  /** --ship green: a containing release exists. */
  released: '#3fb950',
  /** --warn gold: merged/landed but not in any release yet. */
  notYet: '#d29922',
  /** neutral grey: still computing, or an answer we can't give. */
  neutral: '#9f9f9f',
} as const;

const LABEL_BG = '#3a3a3a';
const DEFAULT_LABEL = 'released';

export type BadgeState = {
  readonly message: string;
  readonly color: string;
};

/** Map a completed lookup to a badge message + color.
 *  - firstRelease present → the tag (green). Best-effort partials still show it.
 *  - no firstRelease + partial → "checking…" (grey, short-cached so it flips).
 *  - no firstRelease, complete → "not yet" (gold). */
export function badgeStateForResult(result: LookupResult): BadgeState {
  if (result.firstRelease) {
    return { message: result.firstRelease.tag, color: BADGE_COLORS.released };
  }
  if (result.partial) {
    return { message: 'checking…', color: BADGE_COLORS.neutral };
  }
  return { message: 'not yet', color: BADGE_COLORS.notYet };
}

/** Approximate text width in px at 11px Verdana. We force the rendered text to
 *  this width via `textLength`, so the box always fits regardless of the font
 *  the proxy/browser substitutes — a rough estimate is fine. */
export function estimateTextWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch);
  return w;
}

const NARROW = new Set("!.,:;'|iIjlft()[]{}/\\ ".split(''));
const WIDE = new Set('mwMW@%'.split(''));

function charWidth(ch: string): number {
  if (NARROW.has(ch)) return 4;
  if (WIDE.has(ch)) return 10;
  if (ch >= 'A' && ch <= 'Z') return 8;
  return 7;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Render a two-segment "flat" badge: [label | message]. Returns an SVG string. */
export function renderBadge(opts: { label?: string; message: string; color: string }): string {
  const label = opts.label ?? DEFAULT_LABEL;
  const { message, color } = opts;

  const H = 20;
  const PAD = 6;
  const labelTextW = Math.round(estimateTextWidth(label));
  const msgTextW = Math.round(estimateTextWidth(message));
  const labelW = labelTextW + PAD * 2;
  const msgW = msgTextW + PAD * 2;
  const total = labelW + msgW;

  const labelX = labelW / 2;
  const msgX = labelW + msgW / 2;

  const aria = escapeXml(`${label}: ${message}`);
  const labelEsc = escapeXml(label);
  const msgEsc = escapeXml(message);

  // textLength is at least 1 so the attribute is always valid (empty label/msg).
  const labelLen = Math.max(labelTextW, 1);
  const msgLen = Math.max(msgTextW, 1);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${H}" role="img" aria-label="${aria}">`,
    `<title>${aria}</title>`,
    '<linearGradient id="s" x2="0" y2="100%">',
    '<stop offset="0" stop-color="#bbb" stop-opacity=".1"/>',
    '<stop offset="1" stop-opacity=".1"/>',
    '</linearGradient>',
    `<clipPath id="r"><rect width="${total}" height="${H}" rx="3" fill="#fff"/></clipPath>`,
    '<g clip-path="url(#r)">',
    `<rect width="${labelW}" height="${H}" fill="${LABEL_BG}"/>`,
    `<rect x="${labelW}" width="${msgW}" height="${H}" fill="${color}"/>`,
    `<rect width="${total}" height="${H}" fill="url(#s)"/>`,
    '</g>',
    '<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">',
    `<text x="${labelX}" y="15" fill="#010101" fill-opacity=".3" textLength="${labelLen}">${labelEsc}</text>`,
    `<text x="${labelX}" y="14" textLength="${labelLen}">${labelEsc}</text>`,
    `<text x="${msgX}" y="15" fill="#010101" fill-opacity=".3" textLength="${msgLen}">${msgEsc}</text>`,
    `<text x="${msgX}" y="14" textLength="${msgLen}">${msgEsc}</text>`,
    '</g>',
    '</svg>',
  ].join('');
}
