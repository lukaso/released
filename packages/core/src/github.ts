// Compatibility shim. The GitHub client moved to providers/github/{client,urls}.ts
// and now implements the unified Provider interface. This file re-exports the
// factory under its legacy name so consumers that haven't migrated still work.

export { makeGithubProvider as makeGithubClient } from './providers/github/client.js';
export type { Provider as GithubClient, ProviderOpts as GithubClientOpts } from './provider.js';
