import { describe, expect, it } from 'vitest';
import { KNOWN_PROJECTS, findProjectByAlias } from '../src/known-projects.js';
import { KNOWN_GITLAB_HOSTS } from '../src/providers/index.js';

describe('findProjectByAlias', () => {
  it('returns the entry for a known lowercase alias', () => {
    const gtk = findProjectByAlias('gtk');
    expect(gtk).toBeDefined();
    expect(gtk?.host).toBe('gitlab.gnome.org');
    expect(gtk?.projectPath).toBe('GNOME/gtk');
  });

  it('is case-insensitive on lookup', () => {
    expect(findProjectByAlias('GTK')).toEqual(findProjectByAlias('gtk'));
    expect(findProjectByAlias('React')).toEqual(findProjectByAlias('react'));
    expect(findProjectByAlias('NEXT.JS')).toEqual(findProjectByAlias('next.js'));
  });

  it('returns undefined for an unknown alias', () => {
    expect(findProjectByAlias('totallyfake')).toBeUndefined();
    expect(findProjectByAlias('')).toBeUndefined();
  });

  it('resolves react to facebook/react on github.com', () => {
    const react = findProjectByAlias('react');
    expect(react?.host).toBe('github.com');
    expect(react?.projectPath).toBe('facebook/react');
  });

  it('resolves gimp to GNOME/gimp on gitlab.gnome.org', () => {
    const gimp = findProjectByAlias('gimp');
    expect(gimp?.host).toBe('gitlab.gnome.org');
    expect(gimp?.projectPath).toBe('GNOME/gimp');
  });
});

describe('KNOWN_PROJECTS catalog — sanity', () => {
  it('is non-empty', () => {
    expect(KNOWN_PROJECTS.length).toBeGreaterThan(0);
  });

  it('every entry has non-empty alias, displayName, host, projectPath', () => {
    for (const p of KNOWN_PROJECTS) {
      expect(p.alias, `alias for ${JSON.stringify(p)}`).toBeTruthy();
      expect(p.displayName, `displayName for ${p.alias}`).toBeTruthy();
      expect(p.host, `host for ${p.alias}`).toBeTruthy();
      expect(p.projectPath, `projectPath for ${p.alias}`).toBeTruthy();
    }
  });

  it('all aliases are unique', () => {
    const aliases = KNOWN_PROJECTS.map((p) => p.alias);
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it('all aliases are lowercase', () => {
    for (const p of KNOWN_PROJECTS) {
      expect(p.alias).toBe(p.alias.toLowerCase());
    }
  });

  it('no alias contains a slash (parser depends on this invariant)', () => {
    for (const p of KNOWN_PROJECTS) {
      expect(p.alias.includes('/'), `alias "${p.alias}" should not contain /`).toBe(false);
    }
  });

  it('all hosts are github.com or in KNOWN_GITLAB_HOSTS', () => {
    for (const p of KNOWN_PROJECTS) {
      const ok = p.host === 'github.com' || KNOWN_GITLAB_HOSTS.has(p.host);
      expect(ok, `host "${p.host}" for alias "${p.alias}" must be supported`).toBe(true);
    }
  });

  it('every projectPath has an owner/name shape', () => {
    for (const p of KNOWN_PROJECTS) {
      expect(p.projectPath.includes('/'), `projectPath "${p.projectPath}"`).toBe(true);
    }
  });
});
