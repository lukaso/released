// CLI auth: resolves a provider API token. Resolution order depends on host:
//
//   GitHub (host === 'github.com'):
//     1. --token <t> CLI flag
//     2. GITHUB_TOKEN / GH_TOKEN env vars
//     3. `gh auth token --hostname github.com` shellout
//
//   GitLab (host !== 'github.com'):
//     1. --token <t> CLI flag
//     2. GITLAB_TOKEN_<HOST> / GITLAB_TOKEN env vars (host-specific takes precedence)
//     3. `glab auth token --hostname <host>` shellout
//
// Returns undefined when no token is available — CLI then runs unauthenticated.

import { spawn } from 'node:child_process';

export type AuthOpts = {
  tokenFlag?: string | undefined;
  env?: NodeJS.ProcessEnv;
  /** Provider host — selects token source family. Defaults to 'github.com'. */
  host?: string;
};

export async function resolveToken(opts: AuthOpts = {}): Promise<string | undefined> {
  if (opts.tokenFlag?.trim()) return opts.tokenFlag.trim();
  const env = opts.env ?? process.env;
  const host = opts.host ?? 'github.com';
  if (host === 'github.com') {
    const envToken = env.GITHUB_TOKEN ?? env.GH_TOKEN;
    if (envToken?.trim()) return envToken.trim();
    return await tryShellAuth('gh', 'github.com');
  }
  // GitLab path: host-specific env var first, then generic GITLAB_TOKEN.
  const hostKey = `GITLAB_TOKEN_${host.toUpperCase().replace(/[.-]/g, '_')}`;
  const hostToken = env[hostKey];
  if (hostToken?.trim()) return hostToken.trim();
  const generic = env.GITLAB_TOKEN;
  if (generic?.trim()) return generic.trim();
  return await tryShellAuth('glab', host);
}

/** Try to get a token via `<cli> auth token --hostname <host>`. Returns undefined
 *  if the CLI is missing, not authenticated, or any error occurs. Never throws. */
async function tryShellAuth(cli: 'gh' | 'glab', host: string): Promise<string | undefined> {
  const statusOk = await runCmd(cli, ['auth', 'status', '--hostname', host], 2_000);
  if (!statusOk) return undefined;
  const token = await runCmdCapture(cli, ['auth', 'token', '--hostname', host], 2_000);
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
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(false);
    }, timeoutMs);
  });
}

/** Run a command and capture stdout. Returns undefined on any failure. */
function runCmdCapture(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<string | undefined> {
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
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(undefined);
    }, timeoutMs);
  });
}
