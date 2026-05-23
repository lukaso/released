// The locked design system (D27→D34): dark dev-tool, Geist + Geist Mono,
// near-black bg, fine 1px borders, white CTA, restrained blue accent, muted
// ship green and warn gold used semantically only.

export const STYLES = `
@font-face {
  font-family: 'Geist';
  src: url('/fonts/Geist-Variable.woff2') format('woff2-variations');
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'Geist Mono';
  src: url('/fonts/GeistMono-Variable.woff2') format('woff2-variations');
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}
:root {
  --bg: #0a0a0a;
  --bg-raised: #111111;
  --bg-hover: #1a1a1a;
  --text: #ededed;
  --text-2: #a1a1a1;
  --text-3: #8a8a8a;
  --border: #262626;
  --border-bright: #383838;
  --white: #fafafa;
  --accent: #52a8ff;
  --ship: #3fb950;
  --ship-dim: #1a3a22;
  --warn: #d29922;
  --warn-dim: #3a2f15;
  --example-tint: #16151a;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  background: var(--bg); color: var(--text);
  font-family: 'Geist', sans-serif;
  font-size: 15px; line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  display: flex; flex-direction: column; min-height: 100%;
}
.wrap { width: 100%; max-width: 660px; margin: 0 auto; padding: 0 24px; }
nav {
  display: flex; align-items: center; justify-content: space-between;
  padding: 20px 0; border-bottom: 1px solid var(--border);
}
.wordmark { font-weight: 600; font-size: 16px; letter-spacing: -.01em; display: flex; align-items: center; gap: 7px; }
.wordmark .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
.nav-links { display: flex; gap: 22px; }
.nav-links a { color: var(--text-2); text-decoration: none; font-size: 13.5px; }
.nav-links a:hover { color: var(--text); }
.nav-links a:visited { color: var(--text-2); }
main { flex: 1; padding: 32px 0 48px; }
.headline { font-size: 30px; font-weight: 600; letter-spacing: -.02em; line-height: 1.18; margin-bottom: 8px; }
.orient { font-size: 15px; color: var(--text-2); margin-bottom: 22px; max-width: 50ch; }
.field-label {
  display: block; font-size: 12px; font-weight: 500; color: var(--text-3); margin-bottom: 8px;
  text-transform: uppercase; letter-spacing: .05em;
}
.searchbox {
  display: flex; background: var(--bg-raised);
  border: 1px solid var(--border-bright); border-radius: 8px; overflow: hidden;
}
.searchbox:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(82,168,255,.15); }
.searchbox input {
  flex: 1; background: transparent; border: none; outline: none;
  font-family: 'Geist Mono', monospace; font-size: 14px; padding: 15px 16px; color: var(--text);
}
.searchbox input::placeholder { color: var(--text-3); }
.searchbox button {
  font-family: 'Geist', sans-serif; font-size: 14px; font-weight: 600;
  padding: 0 22px; background: var(--white); color: #0a0a0a;
  border: none; cursor: pointer; white-space: nowrap;
}
.searchbox button:hover { background: #fff; }

/* Loading-state on form submit. JS adds .loading to the form; default
   state hides .btn-loading; loading state hides .btn-label and shows
   the "Looking up…" copy with three animated dots. Pure CSS, no SVG. */
.searchbox button .btn-loading { display: none; }
form[data-loading-form].loading .searchbox button { cursor: progress; opacity: .85; }
form[data-loading-form].loading .searchbox button .btn-label { display: none; }
form[data-loading-form].loading .searchbox button .btn-loading { display: inline; }
form[data-loading-form].loading .searchbox input { color: var(--text-2); }
.dots::after {
  display: inline-block;
  width: 1.2em;
  text-align: left;
  content: '';
  animation: dots 1.4s steps(4, end) infinite;
}
@keyframes dots {
  0%   { content: ''; }
  25%  { content: '.'; }
  50%  { content: '..'; }
  75%  { content: '...'; }
  100% { content: ''; }
}
/* the example/result card */
.example-section { margin-top: 40px; }
.example-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.example-tag {
  font-family: 'Geist Mono', monospace; font-size: 10.5px; font-weight: 700;
  color: #0a0a0a; background: var(--warn); padding: 3px 8px; border-radius: 4px; letter-spacing: .08em;
}
.example-caption { font-size: 13px; color: var(--text-2); }
.example-caption b { color: var(--text); font-weight: 500; }

.answer { background: var(--bg-raised); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.answer.example { background: var(--example-tint); border-style: dashed; border-color: var(--border-bright); }
.answer-hero { padding: 22px 22px 20px; }
.answer-label {
  display: flex; align-items: center; gap: 7px;
  font-size: 12px; font-weight: 500; color: var(--text-3);
  text-transform: uppercase; letter-spacing: .05em; margin-bottom: 12px;
}
.answer-label .ship-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ship); }
.answer-version { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 10px; }
.answer-version .v {
  font-family: 'Geist Mono', monospace; font-weight: 600;
  font-size: 52px; line-height: 1; letter-spacing: -.02em; color: var(--text);
}
.answer-version .ship {
  font-family: 'Geist Mono', monospace; font-size: 11px; font-weight: 600;
  color: var(--ship); background: var(--ship-dim);
  padding: 4px 9px; border-radius: 5px; letter-spacing: .03em;
}
.answer-date { font-size: 15px; color: var(--text-2); margin-bottom: 18px; }
.answer-date b { color: var(--text); font-weight: 500; }
.answer-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.share-lbl {
  font-size: 12px; font-weight: 500; color: var(--text-3);
  text-transform: uppercase; letter-spacing: .05em; margin-right: 2px;
}
.btn-fmt {
  font-family: 'Geist', sans-serif; font-size: 13px; font-weight: 500;
  background: transparent; color: var(--text-2);
  border: 1px solid var(--border-bright); padding: 7px 12px;
  border-radius: 6px; cursor: pointer;
}
.btn-fmt:hover { color: var(--text); border-color: var(--text-3); background: var(--bg-hover); }
.btn-fmt.primary { background: var(--white); color: #0a0a0a; border-color: var(--white); font-weight: 600; }
.btn-fmt.primary:hover { background: #fff; border-color: #fff; }
.perma { margin-left: auto; font-family: 'Geist Mono', monospace; font-size: 11.5px; color: var(--text-3); }
/* Live copy preview: shows what each format produces — the rendered image for
 * "as Badge", the literal string for slack/link. Updates on hover/
 * focus/click of the copy buttons; hidden until populated client-side. */
.copy-preview {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin-top: 12px; padding: 10px 12px;
  background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
}
.copy-preview-label {
  font-size: 11px; font-weight: 500; color: var(--text-3);
  text-transform: uppercase; letter-spacing: .05em; flex-shrink: 0;
}
.copy-preview-badge { display: block; height: 20px; border-radius: 3px; }
.copy-preview-text {
  font-family: 'Geist Mono', monospace; font-size: 12px; color: var(--text-2);
  white-space: pre-wrap; word-break: break-all; line-height: 1.5; min-width: 0;
}
/* The display rules above outrank the UA [hidden]{display:none}, so restore it
 * explicitly — otherwise hidden elements (empty preview, swapped-out badge img)
 * stay visible. */
.copy-preview[hidden], .copy-preview-badge[hidden] { display: none; }
.copy-hint { margin-top: 10px; font-size: 12.5px; color: var(--text-3); }
.answer-meta {
  padding: 12px 22px; border-top: 1px solid var(--border);
  background: rgba(0,0,0,.18);
  font-family: 'Geist Mono', monospace; font-size: 12px; color: var(--text-3);
  display: flex; justify-content: space-between; gap: 10px;
}
/* All links inside the result card need explicit colors — browser defaults
 * (#0000EE blue, #551A8B visited purple) are illegible on the dark surface. */
.answer-meta a {
  color: var(--text-2);
  text-decoration: underline;
  text-decoration-color: var(--border-bright);
  text-underline-offset: 2px;
}
.answer-meta a:hover { color: var(--text); text-decoration-color: var(--text-3); }
.answer-meta a:visited { color: var(--text-2); }
.answer-meta .repo { color: var(--text-2); }
.sec-label a {
  color: var(--text);
  text-decoration: underline;
  text-decoration-color: var(--border-bright);
  text-underline-offset: 2px;
}
.sec-label a:hover { color: var(--accent); text-decoration-color: var(--accent); }
.sec-label a:visited { color: var(--text); }
/* PR/MR resolution banner ("Resolved <MR !N> → merge commit <sha>"). Bare
 * <a> tags here would fall back to #0000EE — illegible on the dark surface. */
.pr-banner {
  margin-bottom: 16px; padding: 12px 16px;
  background: var(--bg-raised); border: 1px solid var(--border);
  border-radius: 8px; font-size: 13.5px; color: var(--text-2);
}
.pr-banner a {
  color: var(--text); text-decoration: underline;
  text-decoration-color: var(--border-bright); text-underline-offset: 2px;
}
.pr-banner a:hover { color: var(--accent); text-decoration-color: var(--accent); }
.pr-banner a:visited { color: var(--text); }
.pr-banner .sha { font-family: 'Geist Mono', monospace; }
/* The hero version is a link — make it discoverable on hover with a subtle
 * underline, but stay clean at rest. */
a.v {
  border-bottom: 2px solid transparent;
  transition: border-color 0.12s ease;
}
a.v:hover { border-bottom-color: var(--accent); }
a.v:visited { color: inherit; }
.answer-sec { border-top: 1px solid var(--border); padding: 16px 22px; }
.sec-label {
  font-size: 11.5px; font-weight: 500; color: var(--text-3);
  text-transform: uppercase; letter-spacing: .05em; margin-bottom: 11px;
}
.notes-html h1, .notes-html h2, .notes-html h3 { font-size: 14px; font-weight: 600; margin-bottom: 6px; color: var(--text); }
.notes-html ul, .notes-html ol { padding-left: 20px; margin-bottom: 6px; }
.notes-html li { color: var(--text); font-size: 14px; margin-bottom: 4px; }
.notes-html p { color: var(--text); font-size: 14px; margin-bottom: 6px; }
.notes-html code { font-family: 'Geist Mono', monospace; font-size: 13px; background: var(--bg); padding: 1px 5px; border-radius: 3px; }
.notes-html a { color: var(--accent); }
.alsoin .versions { display: flex; flex-wrap: wrap; gap: 6px; }
.v-chip {
  font-family: 'Geist Mono', monospace; font-size: 12.5px;
  background: var(--bg); border: 1px solid var(--border);
  color: var(--text-2); text-decoration: none;
  padding: 5px 10px; border-radius: 6px;
}
.v-chip:hover { border-color: var(--border-bright); color: var(--text); }
footer {
  margin-top: auto; border-top: 1px solid var(--border);
  padding: 18px 0; display: flex; gap: 20px; font-size: 13px;
}
footer a { color: var(--text-3); text-decoration: none; }
footer a:hover { color: var(--text-2); }
footer a:visited { color: var(--text-3); }
/* Popular projects chip row — clickable alias shortcuts on the homepage
 * and inside the bare-SHA error banner. Each chip is a real <button>; click
 * inserts the alias into the search input via the delegated handler in
 * layout.tsx (see chip-click.ts for the tested source-of-truth logic). */
.projects-section { margin-top: 28px; }
.projects-label {
  display: block; font-size: 12px; font-weight: 500; color: var(--text-3);
  text-transform: uppercase; letter-spacing: .05em; margin-bottom: 10px;
}
.projects-row { display: flex; flex-wrap: wrap; gap: 6px; }
.project-chip {
  font-family: 'Geist', sans-serif; font-size: 13px; font-weight: 500;
  background: var(--bg-raised); border: 1px solid var(--border);
  color: var(--text-2); padding: 7px 12px; border-radius: 6px;
  cursor: pointer;
  transition: border-color .12s ease, color .12s ease, background .12s ease;
}
.project-chip:hover, .project-chip:focus-visible {
  border-color: var(--border-bright); color: var(--text); background: var(--bg-hover);
}
.project-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.project-chip--just-clicked { border-color: var(--accent); color: var(--text); }
.projects-hint { margin-top: 10px; font-size: 12.5px; color: var(--text-3); }
.error-chips { margin-top: 12px; }
.error-chips .projects-label { color: var(--warn); }

@media (max-width: 600px) {
  .searchbox { flex-direction: column; }
  .searchbox button { padding: 13px; }
  .answer-version .v { font-size: 36px; }
  /* ~40px tap target on touch devices */
  .project-chip { padding: 10px 14px; font-size: 13.5px; }
  .projects-row { gap: 8px; }
}
`;
