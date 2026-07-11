// Guards the wrangler config against the one deploy mistake that silently
// destroys a production credential.
//
// On Workers, `vars` and secrets share ONE namespace per Worker, and a plaintext
// `var` write WINS. So a `[vars]` entry whose name matches an existing secret
// REPLACES that secret on the next deploy — no error, no warning. Cloudflare's
// own `wrangler deploy --help` is careful to say "secrets are never deleted by
// deployments", which is true only of the wholesale wipe `keep_vars` controls;
// it says nothing about a name collision, and the collision is the real killer.
// This is what took a sibling app's prod down for ~11h (lukaso/football#110).
//
// There is NO wrangler flag that catches this — `--strict` does not exist, and
// `--strict-vars` is a `wrangler types` option about literal typing, unrelated.
// The check has to live here, in the gate.
//
// `released` is squarely exposed: RELAY_SECRET (Worker↔Anubis relay container)
// and INTERNAL_SECRET (web↔web-og Service Binding handshake) are both load-bearing
// and both fail QUIETLY — a lost RELAY_SECRET degrades the federated GitLab hosts
// to the "use the CLI" card, and a lost INTERNAL_SECRET fails /internal/* closed.
// The app keeps serving 200s either way.
//
// The vars are read with wrangler's OWN config reader, not a hand-rolled TOML
// parse. That is not a style preference: it is the same parser `wrangler deploy`
// uses, so the guard agrees with the deploy by construction. A regex parse has to
// re-derive TOML and silently misses shapes wrangler honours — a trailing comment
// on `[env.production.vars] # prod overrides` is enough to hide a collision, which
// is the exact football#110 vector.

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { experimental_readRawConfig } from 'wrangler';

/**
 * Every name this project sets via `wrangler secret put`. Adding a secret? Add it
 * here too — that is what arms this guard against it.
 * `GITLAB_TOKEN_*` per-host PATs are matched by prefix (see isSecretName).
 */
const SECRET_NAMES = ['GITHUB_TOKEN', 'GITLAB_TOKEN', 'INTERNAL_SECRET', 'RELAY_SECRET'] as const;

const SECRET_PREFIXES = ['GITLAB_TOKEN_'] as const;

/**
 * Credential-shaped names, so a secret added in the future is caught even if
 * nobody updated SECRET_NAMES above. `_KEY` is included deliberately: it is the
 * most common credential suffix there is (`STRIPE_API_KEY`, `OPENAI_KEY`). It
 * also has the most benign hits (`CACHE_KEY`, a Turnstile public sitekey) — that
 * is what PUBLIC_VARS_ALLOWLIST absorbs. A deliberate allowlist entry is the
 * right price for a guard whose miss is silent and whose false positive is a
 * one-line fix.
 */
const CREDENTIAL_SUFFIX = /_(SECRET|TOKEN|PASSWORD|CREDENTIALS?|KEY)$/;

/**
 * Non-secret vars that are allowed to look credential-shaped. Empty today; this
 * is the escape hatch for a genuinely public var like a cache-key namespace, so
 * the heuristic above never forces someone to fight the gate.
 */
const PUBLIC_VARS_ALLOWLIST: readonly string[] = [];

function isSecretName(name: string): boolean {
  if ((SECRET_NAMES as readonly string[]).includes(name)) return true;
  if (SECRET_PREFIXES.some((p) => name.startsWith(p))) return true;
  return CREDENTIAL_SUFFIX.test(name) && !PUBLIC_VARS_ALLOWLIST.includes(name);
}

/**
 * The keys of every `vars` table wrangler would apply on deploy: the top-level
 * `[vars]` AND every `[env.<name>.vars]`. Named-env vars matter as much as
 * top-level ones — football#110 was a NAMED-ENV var block landing on the prod
 * Worker.
 */
function varNamesFromConfig(configPath: string): string[] {
  const { rawConfig } = experimental_readRawConfig({ config: configPath });
  // wrangler types the named-env map loosely (`{}`), so name the one property
  // this guard reads rather than reaching for `any`.
  const envs = Object.values(
    (rawConfig.env ?? {}) as Record<string, { vars?: Record<string, unknown> }>,
  );
  return [
    ...Object.keys(rawConfig.vars ?? {}),
    ...envs.flatMap((env) => Object.keys(env?.vars ?? {})),
  ];
}

/** Parse a TOML string by handing wrangler a real config file, as on deploy. */
function varNamesFromToml(toml: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'released-vars-'));
  try {
    const configPath = join(dir, 'wrangler.toml');
    writeFileSync(configPath, toml);
    return varNamesFromConfig(configPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The var names in `toml` that would clobber a secret on deploy. */
function findSecretCollisions(toml: string): string[] {
  return varNamesFromToml(toml).filter(isSecretName);
}

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Every Worker in the repo, discovered rather than listed: a new Worker package
 * is guarded the moment its config exists. (`readdirSync` + `existsSync`, not
 * `fs.globSync` — glob landed in Node 22 and CI still runs a Node 20 leg.)
 */
const WORKER_CONFIGS: readonly (readonly [string, string])[] = readdirSync(
  join(REPO_ROOT, 'packages'),
)
  .sort()
  .map((pkg) => [pkg, join(REPO_ROOT, 'packages', pkg, 'wrangler.toml')] as const)
  .filter(([, configPath]) => existsSync(configPath));

describe('the guard itself is armed', () => {
  // A guard that silently stops guarding is worse than none. Both of these fail
  // LOUD if the ground shifts under it.
  it('uses wrangler’s own config reader', () => {
    expect(typeof experimental_readRawConfig).toBe('function');
  });

  it('discovers every Worker config in the repo', () => {
    // If the glob ever matched nothing, describe.each below would run zero cases
    // and the suite would still be green — the silent-no-op failure mode.
    expect(WORKER_CONFIGS.map(([worker]) => worker)).toEqual(['web', 'web-og']);
  });
});

describe('varNamesFromToml', () => {
  it('reads the keys of the top-level [vars] table', () => {
    const toml = `name = "w"\n[vars]\nANUBIS_HOSTS = "a,b"\nPROD_HOST = "x.com"\n`;
    expect(varNamesFromToml(toml)).toEqual(['ANUBIS_HOSTS', 'PROD_HOST']);
  });

  it('reads named-env vars too ([env.x.vars] — the football#110 vector)', () => {
    const toml = `name = "w"\n[env.staging.vars]\nRELAY_SECRET = "oops"\n`;
    expect(varNamesFromToml(toml)).toEqual(['RELAY_SECRET']);
  });

  it('does not treat non-vars tables as vars', () => {
    const toml = `name = "w"\n[vars]\nPROD_HOST = "x"\n\n[[containers]]\nname = "relay"\n`;
    expect(varNamesFromToml(toml)).toEqual(['PROD_HOST']);
  });

  it('ignores commented-out vars (they set nothing)', () => {
    const toml = `name = "w"\n[vars]\n# RELAY_SECRET = "not actually set"\nPROD_HOST = "x"\n`;
    expect(varNamesFromToml(toml)).toEqual(['PROD_HOST']);
  });
});

// Every case below is valid TOML that wrangler honours on deploy and that a
// regex parse silently drops on the floor. They are the reason this reads the
// config through wrangler.
describe('valid-TOML shapes that must not slip past the guard', () => {
  it('sees a var table header carrying a trailing comment', () => {
    const toml = `name = "w"\n[env.production.vars] # prod overrides\nRELAY_SECRET = "leaked"\n`;
    expect(findSecretCollisions(toml)).toEqual(['RELAY_SECRET']);
  });

  it('does not leak keys out of a later table that carries a trailing comment', () => {
    const toml = `name = "w"\n[vars]\nPROD_HOST = "x"\n\n[assets] # static files\ndirectory = "./public"\n`;
    expect(varNamesFromToml(toml)).toEqual(['PROD_HOST']);
  });

  it('sees vars written as an inline table', () => {
    const toml = `name = "w"\nvars = { RELAY_SECRET = "leaked", PROD_HOST = "x" }\n`;
    expect(findSecretCollisions(toml)).toEqual(['RELAY_SECRET']);
  });

  it('sees vars written as a dotted key', () => {
    const toml = `name = "w"\nvars.RELAY_SECRET = "leaked"\n`;
    expect(findSecretCollisions(toml)).toEqual(['RELAY_SECRET']);
  });

  it('sees a quoted key inside [vars]', () => {
    const toml = `name = "w"\n[vars]\n"RELAY_SECRET" = "leaked"\n`;
    expect(findSecretCollisions(toml)).toEqual(['RELAY_SECRET']);
  });
});

describe('findSecretCollisions (the guard must actually bite)', () => {
  it('flags a var that collides with a known secret', () => {
    const toml = `name = "w"\n[vars]\nPROD_HOST = "x"\nRELAY_SECRET = "leaked"\n`;
    expect(findSecretCollisions(toml)).toEqual(['RELAY_SECRET']);
  });

  it('flags a per-host GitLab PAT name (prefix-matched)', () => {
    const toml = `name = "w"\n[vars]\nGITLAB_TOKEN_GITLAB_GNOME_ORG = "leaked"\n`;
    expect(findSecretCollisions(toml)).toEqual(['GITLAB_TOKEN_GITLAB_GNOME_ORG']);
  });

  it('flags a credential-shaped var even if it is not a secret we know yet', () => {
    // The spelling Stripe actually ships is STRIPE_API_KEY, not STRIPE_SECRET —
    // so `_KEY` has to be in CREDENTIAL_SUFFIX or the realistic name walks through.
    const toml = `name = "w"\n[vars]\nSTRIPE_API_KEY = "leaked"\n`;
    expect(findSecretCollisions(toml)).toEqual(['STRIPE_API_KEY']);
  });

  it('flags a collision hidden in a named env', () => {
    const toml = `name = "w"\n[vars]\nPROD_HOST = "x"\n\n[env.preview.vars]\nINTERNAL_SECRET = "leaked"\n`;
    expect(findSecretCollisions(toml)).toEqual(['INTERNAL_SECRET']);
  });

  it('passes ordinary public config vars', () => {
    const toml = `name = "w"\n[vars]\nANUBIS_HOSTS = "a,b"\nPROD_HOST = "x.com"\nEXTRA_GITLAB_HOSTS = "g.example"\n`;
    expect(findSecretCollisions(toml)).toEqual([]);
  });
});

describe.each(WORKER_CONFIGS)('%s wrangler.toml', (worker, configPath) => {
  it('declares no var that would overwrite a secret on deploy', () => {
    const collisions = varNamesFromConfig(configPath).filter(isSecretName);
    expect(
      collisions,
      `${worker}: [vars] declares ${collisions.join(', ')}, which ${
        collisions.length === 1 ? 'is a secret name' : 'are secret names'
      }. On deploy the plaintext var would REPLACE the secret of that name and the ` +
        `failure would be silent. Set it with \`wrangler secret put\` and remove it from [vars].`,
    ).toEqual([]);
  });
});
