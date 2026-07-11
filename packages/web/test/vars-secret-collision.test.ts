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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every name this project sets via `wrangler secret put`. Adding a secret? Add it
 * here too — that is what arms this guard against it.
 * `GITLAB_TOKEN_*` per-host PATs are matched by prefix (see isSecretName).
 */
const SECRET_NAMES = ['GITHUB_TOKEN', 'GITLAB_TOKEN', 'INTERNAL_SECRET', 'RELAY_SECRET'] as const;

const SECRET_PREFIXES = ['GITLAB_TOKEN_'] as const;

/**
 * Credential-shaped names, so a secret added in the future is caught even if
 * nobody updated SECRET_NAMES above. Deliberately conservative: it only fires on
 * a trailing credential word.
 */
const CREDENTIAL_SUFFIX = /_(SECRET|TOKEN|PASSWORD|CREDENTIALS?)$/;

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
 * Collect the keys of every `vars` table in a wrangler.toml: the top-level
 * `[vars]` AND any `[env.<name>.vars]`. Named-env vars matter as much as
 * top-level ones — football#110 was a NAMED-ENV var block landing on the prod
 * Worker. Commented-out lines are ignored (they set nothing).
 */
function varNamesFromWranglerToml(toml: string): string[] {
  const names: string[] = [];
  let inVarsTable = false;

  for (const rawLine of toml.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('#') || line === '') continue;

    // Matches a table header `[x]` AND an array-of-tables header `[[x]]` — both
    // end the preceding table, so `[[containers]]` must reset `inVarsTable`.
    const table = line.match(/^\[\[?([^\]]+)\]\]?$/)?.[1];
    if (table !== undefined) {
      // `[vars]` or `[env.staging.vars]` — but not `[[containers]]`, `[assets]`, …
      inVarsTable = /^(env\.[^.]+\.)?vars$/.test(table.trim());
      continue;
    }
    if (!inVarsTable) continue;

    const key = line.match(/^([A-Za-z0-9_-]+)\s*=/)?.[1];
    if (key !== undefined) names.push(key);
  }
  return names;
}

/** The var names in `toml` that would clobber a secret on deploy. */
function findSecretCollisions(toml: string): string[] {
  return varNamesFromWranglerToml(toml).filter(isSecretName);
}

const WORKER_CONFIGS = [
  ['web', '../wrangler.toml'],
  ['web-og', '../../web-og/wrangler.toml'],
] as const;

describe('varNamesFromWranglerToml', () => {
  it('reads the keys of the top-level [vars] table', () => {
    const toml = `name = "w"\n[vars]\nANUBIS_HOSTS = "a,b"\nPROD_HOST = "x.com"\n`;
    expect(varNamesFromWranglerToml(toml)).toEqual(['ANUBIS_HOSTS', 'PROD_HOST']);
  });

  it('reads named-env vars too ([env.x.vars] — the football#110 vector)', () => {
    const toml = `[env.staging.vars]\nRELAY_SECRET = "oops"\n`;
    expect(varNamesFromWranglerToml(toml)).toEqual(['RELAY_SECRET']);
  });

  it('does not treat non-vars tables as vars', () => {
    const toml = `[vars]\nPROD_HOST = "x"\n\n[[containers]]\nname = "relay"\n`;
    expect(varNamesFromWranglerToml(toml)).toEqual(['PROD_HOST']);
  });

  it('ignores commented-out vars (they set nothing)', () => {
    const toml = `[vars]\n# RELAY_SECRET = "not actually set"\nPROD_HOST = "x"\n`;
    expect(varNamesFromWranglerToml(toml)).toEqual(['PROD_HOST']);
  });
});

describe('findSecretCollisions (the guard must actually bite)', () => {
  it('flags a var that collides with a known secret', () => {
    const toml = `[vars]\nPROD_HOST = "x"\nRELAY_SECRET = "leaked"\n`;
    expect(findSecretCollisions(toml)).toEqual(['RELAY_SECRET']);
  });

  it('flags a per-host GitLab PAT name (prefix-matched)', () => {
    const toml = `[vars]\nGITLAB_TOKEN_GITLAB_GNOME_ORG = "leaked"\n`;
    expect(findSecretCollisions(toml)).toEqual(['GITLAB_TOKEN_GITLAB_GNOME_ORG']);
  });

  it('flags a credential-shaped var even if it is not a secret we know yet', () => {
    const toml = `[vars]\nSTRIPE_SECRET = "leaked"\n`;
    expect(findSecretCollisions(toml)).toEqual(['STRIPE_SECRET']);
  });

  it('flags a collision hidden in a named env', () => {
    const toml = `[vars]\nPROD_HOST = "x"\n\n[env.preview.vars]\nINTERNAL_SECRET = "leaked"\n`;
    expect(findSecretCollisions(toml)).toEqual(['INTERNAL_SECRET']);
  });

  it('passes ordinary public config vars', () => {
    const toml = `[vars]\nANUBIS_HOSTS = "a,b"\nPROD_HOST = "x.com"\nEXTRA_GITLAB_HOSTS = "g.example"\n`;
    expect(findSecretCollisions(toml)).toEqual([]);
  });
});

describe.each(WORKER_CONFIGS)('%s wrangler.toml', (worker, relPath) => {
  const toml = readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), 'utf8');

  it('declares no var that would overwrite a secret on deploy', () => {
    const collisions = findSecretCollisions(toml);
    expect(
      collisions,
      `${worker}: [vars] declares ${collisions.join(', ')}, which ${
        collisions.length === 1 ? 'is a secret name' : 'are secret names'
      }. On deploy the plaintext var would REPLACE the secret of that name and the ` +
        `failure would be silent. Set it with \`wrangler secret put\` and remove it from [vars].`,
    ).toEqual([]);
  });
});
