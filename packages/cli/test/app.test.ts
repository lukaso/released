import { afterEach, describe, expect, it, vi } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { VERSION, run } from '../src/app.js';

describe('VERSION', () => {
  it('matches the published package.json version', () => {
    // Regression guard: the CLI used to hardcode "0.0.0", so `--version` and
    // npm metadata disagreed on a published package.
    expect(VERSION).toBe(pkg.version);
  });

  it('is a real semver, never the 0.0.0 placeholder', () => {
    expect(VERSION).not.toBe('0.0.0');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('run()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns exit code 2 and writes an error when input is missing', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const code = await run(undefined, undefined, {});

    expect(code).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('missing input'));
  });
});
