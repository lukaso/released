// CLI auth: resolves a GitHub token from (in order):
//   1. --token <t> CLI flag
//   2. GITHUB_TOKEN env var
//   3. `gh auth token` shellout (only if gh is on PATH and logged into github.com)
// Returns undefined when no token is available — CLI then runs unauthenticated.

import { spawn } from 'node:child_process';

export type AuthOpts = {
  tokenFlag?: string | undefined;
  env?: NodeJS.ProcessEnv;
};

export async function resolveToken(opts: AuthOpts = {}): Promise<string | undefined> {
  if (opts.tokenFlag && opts.tokenFlag.trim()) return opts.tokenFlag.trim();
  const env = opts.env ?? process.env;
  const envToken = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (envToken && envToken.trim()) return envToken.trim();
  return await tryGhAuth();
}

/** Try to get a token from `gh`. Returns undefined if `gh` is missing,
 *  not authenticated to github.com, or any error occurs. Never throws. */
async function tryGhAuth(): Promise<string | undefined> {
  // First check: is gh logged in to github.com (not GHE)?
  const statusOk = await runCmd('gh', ['auth', 'status', '--hostname', 'github.com'], 2_000);
  if (!statusOk) return undefined;
  // Then extract the token.
  const token = await runCmdCapture('gh', ['auth', 'token'], 2_000);
  return token?.trim() || undefined;
}

/** Returns true on exit code 0, false otherwise (incl. timeout / not-found). */
function runCmd(cmd: string, args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: 'ignore' });
    } catch {
      return finish(false);
    }
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
    setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(false);
    }, timeoutMs);
  });
}

/** Run a command and capture stdout. Returns undefined on any failure. */
function runCmdCapture(cmd: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let done = false;
    let out = '';
    const finish = (v: string | undefined) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return finish(undefined);
    }
    child.stdout?.on('data', (b: Buffer) => {
      out += b.toString('utf8');
    });
    child.on('error', () => finish(undefined));
    child.on('close', (code) => finish(code === 0 ? out : undefined));
    setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(undefined);
    }, timeoutMs);
  });
}
