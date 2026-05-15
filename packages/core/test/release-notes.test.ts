import { describe, expect, it } from 'vitest';
import { renderReleaseNotes } from '../src/release-notes.js';

describe('renderReleaseNotes — sanitization', () => {
  it('renders normal markdown to HTML', async () => {
    const html = await renderReleaseNotes('## Changes\n\n- fix: hydration mismatch');
    expect(html).toContain('<h2>');
    expect(html).toContain('fix: hydration mismatch');
  });

  it('returns null for empty input', async () => {
    expect(await renderReleaseNotes('')).toBeNull();
    expect(await renderReleaseNotes('   \n  ')).toBeNull();
  });

  it('strips raw <script> tags (escapes the angle brackets)', async () => {
    const html = await renderReleaseNotes('hello <script>alert(1)</script> world');
    // No raw <script> tag in the output — escaped to &lt;script&gt; (safe text).
    expect(html).not.toMatch(/<script\b/i);
  });

  it('rejects markdown image with javascript: URI', async () => {
    const html = await renderReleaseNotes('![](javascript:alert(1))');
    expect(html).not.toMatch(/\bsrc\s*=\s*"javascript:/i);
  });

  it('strips raw <svg> tags (escapes the angle brackets)', async () => {
    const html = await renderReleaseNotes('start <svg onload="alert(1)"></svg> end');
    expect(html).not.toMatch(/<svg\b/i);
  });

  it('strips raw <iframe> tags', async () => {
    const html = await renderReleaseNotes('a <iframe src="https://evil.example"></iframe> b');
    expect(html).not.toMatch(/<iframe\b/i);
  });

  it('rejects markdown link with javascript: URI', async () => {
    const html = await renderReleaseNotes('[click me](javascript:alert(1))');
    expect(html).not.toMatch(/href\s*=\s*"javascript:/i);
  });

  it('rejects markdown link with vbscript: URI', async () => {
    const html = await renderReleaseNotes('[click me](vbscript:msgbox(1))');
    expect(html).not.toMatch(/href\s*=\s*"vbscript:/i);
  });

  it('preserves safe links (https://)', async () => {
    const html = await renderReleaseNotes('see [docs](https://example.com/x)');
    expect(html).toMatch(/href\s*=\s*"https:\/\/example\.com\/x"/);
  });
});
