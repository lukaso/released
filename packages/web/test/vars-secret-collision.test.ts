// Guards the wrangler config against the one deploy mistake that silently
// destroys a production credential.
//
// On Workers, `vars` and secrets share ONE namespace per Worker, and a plaintext
// `var` write WINS. So a `vars` entry whose name matches an existing secret
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
// Configs are read with real parsers, never a hand-rolled regex. That is not a
// style preference: a regex has to re-derive TOML and silently misses shapes
// wrangler honours on deploy — a trailing comment on `[env.production.vars] # prod
// overrides` is enough to hide a collision, which is the exact football#110 vector.
//
// TOML parses with `smol-toml` rather than wrangler's own config reader, which
// would otherwise be the obvious choice. Importing `wrangler` anywhere in this
// repo's module graph is NODE-20-HOSTILE: root package.json pins
// `pnpm.overrides.undici: ">=7.28.0"` globally (for jsdom), which forces undici 7
// into wrangler's miniflare, and on Node 20 that throws
// `webidl.util.markAsUncloneable is not a function` — under plain Node as much as
// under vitest. CI runs a Node 20 leg, so wrangler cannot be imported here.
// smol-toml is spec-compliant and dependency-free, and was checked on Node 20
// against every shape below. JSON/JSONC parses with `jsonc-parser`: comments and
// trailing commas are legal in a wrangler.jsonc, so `JSON.parse` would throw.
//
// Both Workers are TOML today, but a NEW Worker would not be: `wrangler init` has
// emitted JSONC by default since v3.91, and Cloudflare's own tooling now steers
// you to it. So the guard resolves a package's config the way wrangler itself
// does — the precedence in CONFIG_BASENAMES is read straight out of
// `findWranglerConfig` in wrangler 4.105.0's dist, not from memory.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';

/**
 * Every name this project sets via `wrangler secret put`. Adding a secret? Add it
 * here too — that is what arms this guard against it. The env.ts classification
 * test at the bottom is what stops that from being something you have to remember.
 * `GITLAB_TOKEN_*` per-host PATs are matched by prefix (see isSecretName).
 */
const SECRET_NAMES = ['GITHUB_TOKEN', 'GITLAB_TOKEN', 'INTERNAL_SECRET', 'RELAY_SECRET'] as const;

const SECRET_PREFIXES = ['GITLAB_TOKEN_'] as const;

/**
 * Bindings that are deliberately PUBLIC config, not credentials. Used by the
 * env.ts classification test: every string binding a Worker declares must land in
 * exactly one of these two lists, so a new secret cannot be added to the app
 * without also arming this guard against it.
 */
const PUBLIC_BINDINGS = [
  'ANUBIS_HOSTS',
  'EXTRA_GITLAB_HOSTS',
  'OG_BASE_URL',
  'PROD_HOST',
  'PUBLIC_BASE_URL',
] as const;

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

/** A var wrangler would apply on deploy, and the table it was declared in. */
type VarEntry = {
  name: string;
  /** Dotted path of the owning table: `vars`, or `env.<name>.vars`. */
  table: string;
};

/**
 * The config filenames wrangler accepts, in the precedence order it applies when
 * more than one exists: `wrangler.json` first, then `.jsonc`, then `.toml`
 * (`findWranglerConfig`, wrangler 4.105.0). Precedence is load-bearing here — a
 * guard that read the `.toml` of a package that also had a `.json` would be
 * auditing a file wrangler never loads, and reporting green about the wrong file
 * is exactly the silent no-op this suite exists to prevent.
 */
const CONFIG_BASENAMES = ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml'] as const;

/** The config wrangler would actually load for `pkgDir`, or undefined if it has none. */
function activeConfigIn(pkgDir: string): string | undefined {
  return CONFIG_BASENAMES.map((base) => join(pkgDir, base)).find((p) => existsSync(p));
}

/**
 * Every `vars` entry wrangler would apply on deploy: the top-level `vars` table
 * AND every `env.<name>.vars`. Named-env vars matter as much as top-level ones —
 * football#110 was a NAMED-ENV var block landing on the prod Worker.
 */
function varEntriesFromText(text: string, filename: string): VarEntry[] {
  // Only the KEYS of a `vars` table are read, never the values — so this never
  // holds a credential, even when pointed at a config that leaks one.
  const config = (filename.endsWith('.toml') ? parseToml(text) : parseJsonc(text)) as {
    vars?: Record<string, unknown>;
    env?: Record<string, { vars?: Record<string, unknown> } | undefined>;
  };
  return [
    ...Object.keys(config.vars ?? {}).map((name) => ({ name, table: 'vars' })),
    ...Object.entries(config.env ?? {}).flatMap(([envName, env]) =>
      Object.keys(env?.vars ?? {}).map((name) => ({ name, table: `env.${envName}.vars` })),
    ),
  ];
}

const varEntriesFromConfig = (configPath: string): VarEntry[] =>
  varEntriesFromText(readFileSync(configPath, 'utf8'), configPath);

/** The vars in `text` that would clobber a secret on deploy. */
function findSecretCollisions(text: string, filename = 'wrangler.toml'): VarEntry[] {
  return varEntriesFromText(text, filename).filter((entry) => isSecretName(entry.name));
}

/**
 * One line per colliding NAME, naming the table(s) it was declared in — so the
 * person reading the failure knows which block to open. A name declared in two
 * tables is ONE collision, reported once.
 */
function describeCollisions(collisions: readonly VarEntry[]): string[] {
  const tablesByName = new Map<string, string[]>();
  for (const { name, table } of collisions) {
    const tables = tablesByName.get(name) ?? [];
    if (!tables.includes(table)) tables.push(table);
    tablesByName.set(name, tables);
  }
  return [...tablesByName].map(([name, tables]) => `${name} (in ${tables.join(', ')})`);
}

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Every Worker in the repo, discovered rather than listed: a new Worker package is
 * guarded the moment its config exists, in whichever format it is written.
 * (`readdirSync` + `existsSync`, not `fs.globSync` — glob landed in Node 22 and CI
 * still runs a Node 20 leg.)
 */
const WORKER_CONFIGS: readonly (readonly [string, string])[] = readdirSync(
  join(REPO_ROOT, 'packages'),
)
  .sort()
  .map((pkg) => [pkg, activeConfigIn(join(REPO_ROOT, 'packages', pkg))] as const)
  .filter((entry): entry is readonly [string, string] => entry[1] !== undefined);

describe('the guard itself is armed', () => {
  // A guard that silently stops guarding is worse than none, so pin the ways this
  // one could rot into a no-op that still reports green.

  it('discovers the Workers in the repo', () => {
    // If discovery ever returned nothing, describe.each below would run zero cases
    // and the suite would still pass — the silent-no-op failure mode. Asserted as
    // "at least the two we know about", NOT as an exact list: pinning the exact set
    // would defeat the discovery it exists to protect, and would turn the happy-path
    // arrival of a third Worker into a red gate.
    const workers = WORKER_CONFIGS.map(([worker]) => worker);
    expect(workers.length).toBeGreaterThan(0);
    expect(workers).toEqual(expect.arrayContaining(['web', 'web-og']));
  });

  it('resolves a package config the way wrangler does (json > jsonc > toml)', () => {
    // Pins the precedence read out of wrangler's own findWranglerConfig. If a future
    // wrangler reorders it, this fails and the guard gets re-pointed at whichever
    // file is really deployed, instead of silently auditing the wrong one.
    expect([...CONFIG_BASENAMES]).toEqual(['wrangler.json', 'wrangler.jsonc', 'wrangler.toml']);
  });

  it('actually parses the real configs (not silently reading nothing)', () => {
    // `web` genuinely declares vars; a parser returning [] for it would make every
    // collision check below vacuously pass.
    const [, webConfig] = WORKER_CONFIGS.find(([worker]) => worker === 'web') ?? [];
    expect(webConfig).toBeDefined();
    expect(varEntriesFromConfig(webConfig as string).map((v) => v.name)).toContain('PROD_HOST');
  });
});

describe('varEntriesFromText', () => {
  it('reads the keys of the top-level vars table', () => {
    const toml = `name = "w"\n[vars]\nANUBIS_HOSTS = "a,b"\nPROD_HOST = "x.com"\n`;
    expect(varEntriesFromText(toml, 'wrangler.toml')).toEqual([
      { name: 'ANUBIS_HOSTS', table: 'vars' },
      { name: 'PROD_HOST', table: 'vars' },
    ]);
  });

  it('reads named-env vars too (env.x.vars — the football#110 vector)', () => {
    const toml = `name = "w"\n[env.staging.vars]\nRELAY_SECRET = "oops"\n`;
    expect(varEntriesFromText(toml, 'wrangler.toml')).toEqual([
      { name: 'RELAY_SECRET', table: 'env.staging.vars' },
    ]);
  });

  it('does not treat non-vars tables as vars', () => {
    const toml = `name = "w"\n[vars]\nPROD_HOST = "x"\n\n[[containers]]\nname = "relay"\n`;
    expect(varEntriesFromText(toml, 'wrangler.toml')).toEqual([
      { name: 'PROD_HOST', table: 'vars' },
    ]);
  });

  it('ignores commented-out vars (they set nothing)', () => {
    const toml = `name = "w"\n[vars]\n# RELAY_SECRET = "not actually set"\nPROD_HOST = "x"\n`;
    expect(varEntriesFromText(toml, 'wrangler.toml')).toEqual([
      { name: 'PROD_HOST', table: 'vars' },
    ]);
  });
});

// Every case below is valid TOML that wrangler honours on deploy and that a regex
// parse silently drops on the floor. They are the reason this uses a real parser.
describe('valid-TOML shapes that must not slip past the guard', () => {
  it('sees a var table header carrying a trailing comment', () => {
    const toml = `name = "w"\n[env.production.vars] # prod overrides\nRELAY_SECRET = "leaked"\n`;
    expect(describeCollisions(findSecretCollisions(toml))).toEqual([
      'RELAY_SECRET (in env.production.vars)',
    ]);
  });

  it('does not leak keys out of a later table that carries a trailing comment', () => {
    const toml = `name = "w"\n[vars]\nPROD_HOST = "x"\n\n[assets] # static files\ndirectory = "./public"\n`;
    expect(varEntriesFromText(toml, 'wrangler.toml')).toEqual([
      { name: 'PROD_HOST', table: 'vars' },
    ]);
  });

  it('sees vars written as an inline table', () => {
    const toml = `name = "w"\nvars = { RELAY_SECRET = "leaked", PROD_HOST = "x" }\n`;
    expect(findSecretCollisions(toml).map((v) => v.name)).toEqual(['RELAY_SECRET']);
  });

  it('sees vars written as a dotted key', () => {
    const toml = `name = "w"\nvars.RELAY_SECRET = "leaked"\n`;
    expect(findSecretCollisions(toml).map((v) => v.name)).toEqual(['RELAY_SECRET']);
  });

  it('sees a quoted key inside [vars]', () => {
    const toml = `name = "w"\n[vars]\n"RELAY_SECRET" = "leaked"\n`;
    expect(findSecretCollisions(toml).map((v) => v.name)).toEqual(['RELAY_SECRET']);
  });
});

// A Worker written by today's `wrangler init` is JSONC, not TOML. These pin that
// the guard bites there too: the format is a detail, the collision is the same.
describe('JSON / JSONC configs (what a new Worker would be written in)', () => {
  it('reads vars out of a plain wrangler.json', () => {
    const json = `{"name":"w","vars":{"PROD_HOST":"x.com","RELAY_SECRET":"leaked"}}`;
    expect(describeCollisions(findSecretCollisions(json, 'wrangler.json'))).toEqual([
      'RELAY_SECRET (in vars)',
    ]);
  });

  it('reads a wrangler.jsonc carrying comments and a trailing comma', () => {
    // Both are legal in a wrangler.jsonc and both make JSON.parse throw, which is
    // why this goes through a real JSONC parser.
    const jsonc = `{
      // prod overrides
      "name": "w",
      "env": {
        "production": {
          "vars": { "INTERNAL_SECRET": "leaked" }, /* clobbers the binding secret */
        },
      },
    }`;
    expect(describeCollisions(findSecretCollisions(jsonc, 'wrangler.jsonc'))).toEqual([
      'INTERNAL_SECRET (in env.production.vars)',
    ]);
  });

  it('passes an ordinary wrangler.jsonc with only public vars', () => {
    const jsonc = `{ "name": "w", "vars": { "ANUBIS_HOSTS": "a,b" } }`;
    expect(findSecretCollisions(jsonc, 'wrangler.jsonc')).toEqual([]);
  });
});

describe('findSecretCollisions (the guard must actually bite)', () => {
  it('flags a var that collides with a known secret', () => {
    const toml = `name = "w"\n[vars]\nPROD_HOST = "x"\nRELAY_SECRET = "leaked"\n`;
    expect(findSecretCollisions(toml)).toEqual([{ name: 'RELAY_SECRET', table: 'vars' }]);
  });

  it('flags a per-host GitLab PAT name (prefix-matched)', () => {
    const toml = `name = "w"\n[vars]\nGITLAB_TOKEN_GITLAB_GNOME_ORG = "leaked"\n`;
    expect(findSecretCollisions(toml).map((v) => v.name)).toEqual([
      'GITLAB_TOKEN_GITLAB_GNOME_ORG',
    ]);
  });

  it('flags a credential-shaped var even if it is not a secret we know yet', () => {
    // The spelling Stripe actually ships is STRIPE_API_KEY, not STRIPE_SECRET — so
    // `_KEY` has to be in CREDENTIAL_SUFFIX or the realistic name walks through.
    const toml = `name = "w"\n[vars]\nSTRIPE_API_KEY = "leaked"\n`;
    expect(findSecretCollisions(toml).map((v) => v.name)).toEqual(['STRIPE_API_KEY']);
  });

  it('names the env table a collision is hiding in, not just vars', () => {
    // The whole job of the message is to send someone to the right block.
    const toml = `name = "w"\n[vars]\nPROD_HOST = "x"\n\n[env.preview.vars]\nINTERNAL_SECRET = "leaked"\n`;
    expect(describeCollisions(findSecretCollisions(toml))).toEqual([
      'INTERNAL_SECRET (in env.preview.vars)',
    ]);
  });

  it('reports a name declared in two tables once, naming both', () => {
    const toml = `name = "w"\n[vars]\nRELAY_SECRET = "leaked"\n\n[env.production.vars]\nRELAY_SECRET = "also leaked"\n`;
    expect(describeCollisions(findSecretCollisions(toml))).toEqual([
      'RELAY_SECRET (in vars, env.production.vars)',
    ]);
  });

  it('passes ordinary public config vars', () => {
    const toml = `name = "w"\n[vars]\nANUBIS_HOSTS = "a,b"\nPROD_HOST = "x.com"\nEXTRA_GITLAB_HOSTS = "g.example"\n`;
    expect(findSecretCollisions(toml)).toEqual([]);
  });
});

/**
 * The string bindings a Worker declares in its `Env` type — the closest thing the
 * repo has to a registry of "values that arrive from wrangler at runtime".
 */
function bindingNamesFromEnvTs(src: string): string[] {
  return [...src.matchAll(/^ {2}([A-Z][A-Z0-9_]*)\??:\s*string;/gm)].flatMap(
    ([, name]) => name ?? [],
  );
}

const ENV_TYPES: readonly (readonly [string, string])[] = WORKER_CONFIGS.map(
  ([worker, configPath]) => [worker, join(configPath, '..', 'src', 'env.ts')] as const,
).filter(([, envPath]) => existsSync(envPath));

describe('every binding is classified as a secret or as public config', () => {
  // Closes the gap that SECRET_NAMES is a hand-kept list sitting next to a
  // src/env.ts that already declares the same names, with nothing tying the two
  // together. A future SIGNING_PEM or WEBHOOK_HMAC matches no CREDENTIAL_SUFFIX
  // pattern, so without this it would be added to the app and walk straight past
  // the guard. Now it cannot: adding a binding to env.ts without classifying it
  // fails here, and classifying it as a secret is what arms the guard against it.

  it('finds at least one Env type to check (else this is a no-op)', () => {
    expect(ENV_TYPES.length).toBeGreaterThan(0);
  });

  it.each(ENV_TYPES)('%s: src/env.ts', (worker, envPath) => {
    const bindings = bindingNamesFromEnvTs(readFileSync(envPath, 'utf8'));
    expect(bindings.length, `${worker}: parsed no bindings out of src/env.ts`).toBeGreaterThan(0);

    const unclassified = bindings.filter(
      (name) => !isSecretName(name) && !(PUBLIC_BINDINGS as readonly string[]).includes(name),
    );
    expect(
      unclassified,
      `${worker}: ${unclassified.join(', ')} declared in src/env.ts but classified neither as a ` +
        'secret nor as public config. If it is set with `wrangler secret put`, add it to ' +
        'SECRET_NAMES — that is what arms this guard against it. If it is public config, add it ' +
        'to PUBLIC_BINDINGS.',
    ).toEqual([]);
  });
});

describe('every armed secret is a declared binding (the reverse of the classification above)', () => {
  // The classification test proves every binding in src/env.ts is classified as a
  // secret or as public — but that only runs ONE direction (env.ts → classified).
  // It cannot catch a name that is ARMED here in SECRET_NAMES yet never actually
  // declared on any Env type, which is exactly how INTERNAL_SECRET sat for months:
  // read via an inline `as Env & { INTERNAL_SECRET?: string }` cast in
  // routes/internal.ts instead of from the typed Env. A secret that lives only in
  // an inline cast escapes the type registry entirely — neither type-checked nor
  // visible to the classification test — so this pins the reverse: every name we
  // arm the guard against must be a real, typed binding on some Worker's Env.
  it('every SECRET_NAME is declared on at least one Worker Env type', () => {
    const declared = new Set<string>();
    for (const [, envPath] of ENV_TYPES) {
      for (const name of bindingNamesFromEnvTs(readFileSync(envPath, 'utf8'))) {
        declared.add(name);
      }
    }
    const untyped = (SECRET_NAMES as readonly string[]).filter((name) => !declared.has(name));
    expect(
      untyped,
      `${untyped.join(', ')} armed in SECRET_NAMES but declared on no Env type. A secret that ` +
        'is not a typed binding escapes the registry (and is read via an inline cast). Declare it ' +
        'on the Worker Env that reads it.',
    ).toEqual([]);
  });
});

describe.each(WORKER_CONFIGS)('%s wrangler config', (worker, configPath) => {
  it('declares no var that would overwrite a secret on deploy', () => {
    const collisions = varEntriesFromConfig(configPath).filter((v) => isSecretName(v.name));
    const named = describeCollisions(collisions);
    expect(
      named,
      `${worker}: ${named.join('; ')} — ${
        named.length === 1 ? 'that name is a secret' : 'those names are secrets'
      }. On deploy the plaintext var would REPLACE the secret of that name and the ` +
        'failure would be silent. Set it with `wrangler secret put` and remove it from vars.',
    ).toEqual([]);
  });
});
