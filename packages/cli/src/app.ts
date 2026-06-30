// CLI logic, with no top-level side effects so it can be imported and tested.
// The executable entry (`cli.ts`) imports `buildCli()` and calls `.parse()`.

import {
  type LookupResult,
  NoReleasesError,
  NotYetReleasedError,
  PrNotMergedError,
  RateLimitError,
  ReleasedError,
  cacheKey,
  findRelease,
  parseInput,
  providerFor,
} from '@released/core';
import { type CAC, cac } from 'cac';
import pkg from '../package.json' with { type: 'json' };
import { resolveToken } from './auth.js';
import { makeFileCache } from './cache.js';
import { type FormatKind, formatResult } from './format.js';

export type Flags = {
  json?: boolean;
  slack?: boolean;
  markdown?: boolean;
  token?: string;
  noCache?: boolean;
  strict?: boolean;
  includePrereleases?: boolean;
};

const NAME = 'released';
// Single source of truth: the published package.json. tsup inlines this at
// build time, so the bundled bin reports the same version npm shipped.
export const VERSION: string = pkg.version;

export function buildCli(): CAC {
  const cli = cac(NAME);

  cli
    .command('[input] [ref]', 'Find the first release that contains a commit.')
    .option('--json', 'Output JSON for scripting.')
    .option('--slack', 'Output Slack mrkdwn (paste into a Slack message).')
    .option('--markdown', 'Output GitHub-flavored markdown (paste into a PR comment).')
    .option('--token <t>', 'GitHub token. Falls back to GITHUB_TOKEN, then `gh auth token`.')
    .option('--no-cache', 'Bypass local cache.')
    .option(
      '--strict',
      'Disable the 90-day date cull. Slower on repos with imported pre-history (CVS/SVN), ' +
        'but finds containing tags whose underlying commits have manually-backdated dates.',
    )
    .option(
      '--include-prereleases',
      'Include alpha/beta/rc/etc tags. Default is production-only ("did my fix ship to users?").',
    )
    .example('released github.com/facebook/react/commit/a1b2c3d')
    .example('released vercel/next.js#56012')
    .example('released facebook/react a1b2c3d')
    .example('git released a1b2c3d   # via the bin alias when in a checkout')
    .action(async (input: string | undefined, ref: string | undefined, flags: Flags) => {
      const exitCode = await run(input, ref, flags);
      process.exit(exitCode);
    });

  cli.help();
  cli.version(VERSION);
  return cli;
}

// --- impl --------------------------------------------------------------------

export async function run(
  input: string | undefined,
  ref: string | undefined,
  flags: Flags,
): Promise<number> {
  if (!input) {
    process.stderr.write('error: missing input. Try `released --help`.\n');
    return 2;
  }
  const format = pickFormat(flags);

  try {
    const parsed = parseInput(input, ref);
    const token = await resolveToken({ tokenFlag: flags.token, host: parsed.repo.host });
    const client = providerFor(parsed.repo.host, { token });
    const cache = flags.noCache ? null : makeFileCache();

    let result: LookupResult | null = null;
    const cacheK = await cacheKey(
      'res',
      `${parsed.repo.host}/${parsed.repo.projectPath}`,
      refKey(parsed),
      flags.strict ? 'strict' : 'cull',
      flags.includePrereleases ? 'pre' : 'nopre',
    );
    if (cache) {
      result = await cache.get<LookupResult>(cacheK);
    }
    if (!result) {
      result = await findRelease(parsed, {
        client,
        strict: flags.strict,
        includePrereleases: flags.includePrereleases,
      });
      if (cache) await cache.put(cacheK, result, 30 * 60);
    }

    process.stdout.write(`${formatResult(result, format)}\n`);
    // Exit code: 0 if released; 1 if not-yet-released-but-it's-not-an-error path
    return result.firstRelease ? 0 : 1;
  } catch (err) {
    return reportError(err, format, flags);
  }
}

function refKey(p: ReturnType<typeof parseInput>): string {
  if (p.kind === 'pr') return `pr#${p.number}`;
  if (p.kind === 'issue') return `issue#${p.number}`;
  return `sha:${p.sha}`;
}

function pickFormat(flags: Flags): FormatKind {
  if (flags.json) return 'json';
  if (flags.slack) return 'slack';
  if (flags.markdown) return 'markdown';
  return 'human';
}

function reportError(err: unknown, format: FormatKind, flags: Flags): number {
  // JSON mode emits an error envelope, so callers can parse failures uniformly.
  if (format === 'json' && err instanceof ReleasedError) {
    const env: Record<string, unknown> = { error: err.kind, message: err.message };
    if (err instanceof NotYetReleasedError) {
      if (err.culledTagCount > 0) env.culledTagCount = err.culledTagCount;
      if (err.prereleasedSkippedCount > 0)
        env.prereleasedSkippedCount = err.prereleasedSkippedCount;
      const hints: string[] = [];
      if (err.prereleasedSkippedCount > 0 && !flags.includePrereleases) {
        hints.push('try --include-prereleases to also check alpha/beta/rc tags');
      }
      if (err.culledTagCount > 0 && !flags.strict) {
        hints.push('try --strict to also check tags more than 90 days older than the commit');
      }
      if (hints.length > 0) env.hint = hints;
    }
    process.stdout.write(`${JSON.stringify(env)}\n`);
  } else {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    if (err instanceof NotYetReleasedError) {
      if (err.prereleasedSkippedCount > 0 && !flags.includePrereleases) {
        process.stderr.write(
          `hint: ${err.prereleasedSkippedCount} prerelease tag(s) (alpha/beta/rc/...) were skipped. ` +
            `Re-run with --include-prereleases to also check them.\n`,
        );
      }
      if (err.culledTagCount > 0 && !flags.strict) {
        process.stderr.write(
          `hint: ${err.culledTagCount} older tag(s) were skipped by the 90-day date cull. ` +
            `Re-run with --strict if a containing tag might have a manually-backdated commit.\n`,
        );
      }
    }
  }
  // Exit code by error class:
  if (err instanceof NoReleasesError) return 4;
  if (err instanceof NotYetReleasedError) return 1;
  if (err instanceof PrNotMergedError) return 3;
  if (err instanceof RateLimitError) return 5;
  if (err instanceof ReleasedError) return 2;
  return 70; // sysexits: EX_SOFTWARE
}
