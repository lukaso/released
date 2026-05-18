// Curated catalog of well-known projects, surfaced as homepage chips and
// accepted by the parser as `<alias> <sha>` / `<alias> #<pr>` shorthand.
//
// Hand-edited. Aliases are lowercase, unique, and contain no slash — the
// parser depends on these invariants (see test/known-projects.test.ts).
// Display names match how each project self-presents in the wild.

export type KnownProject = {
  readonly alias: string;
  readonly displayName: string;
  readonly host: string;
  readonly projectPath: string;
  readonly description?: string;
};

export const KNOWN_PROJECTS: readonly KnownProject[] = [
  // GitHub
  { alias: 'react', displayName: 'React', host: 'github.com', projectPath: 'facebook/react' },
  { alias: 'next.js', displayName: 'Next.js', host: 'github.com', projectPath: 'vercel/next.js' },
  {
    alias: 'kubernetes',
    displayName: 'Kubernetes',
    host: 'github.com',
    projectPath: 'kubernetes/kubernetes',
  },
  { alias: 'hono', displayName: 'Hono', host: 'github.com', projectPath: 'honojs/hono' },
  {
    alias: 'typescript',
    displayName: 'TypeScript',
    host: 'github.com',
    projectPath: 'microsoft/TypeScript',
  },
  { alias: 'node', displayName: 'Node', host: 'github.com', projectPath: 'nodejs/node' },
  {
    alias: 'tailwind',
    displayName: 'Tailwind',
    host: 'github.com',
    projectPath: 'tailwindlabs/tailwindcss',
  },
  { alias: 'vscode', displayName: 'VS Code', host: 'github.com', projectPath: 'microsoft/vscode' },

  // GitLab (gnome.org)
  { alias: 'gtk', displayName: 'GTK', host: 'gitlab.gnome.org', projectPath: 'GNOME/gtk' },
  { alias: 'gimp', displayName: 'GIMP', host: 'gitlab.gnome.org', projectPath: 'GNOME/gimp' },
  { alias: 'glib', displayName: 'GLib', host: 'gitlab.gnome.org', projectPath: 'GNOME/glib' },

  // GitLab (gitlab.com)
  {
    alias: 'gitlab',
    displayName: 'GitLab',
    host: 'gitlab.com',
    projectPath: 'gitlab-org/gitlab',
  },
];

// Built once at module init — O(1) lookups.
const ALIAS_INDEX: ReadonlyMap<string, KnownProject> = new Map(
  KNOWN_PROJECTS.map((p) => [p.alias.toLowerCase(), p]),
);

export function findProjectByAlias(
  alias: string,
  catalog?: readonly KnownProject[],
): KnownProject | undefined {
  if (!alias) return undefined;
  const key = alias.toLowerCase();
  if (!catalog) return ALIAS_INDEX.get(key);
  // Custom catalog passed in (e.g., from ParseOpts.aliases).
  return catalog.find((p) => p.alias.toLowerCase() === key);
}
