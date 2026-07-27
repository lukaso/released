// Worker environment bindings (wrangler.toml + secrets).
//
// Declared in its own module so the vars-secret-collision guard in
// packages/web/test/vars-secret-collision.test.ts covers web-og too: that guard
// maps each Worker config to <pkg>/src/env.ts and parses the string bindings
// here. When this lived inline in index.tsx, web-og was dropped from the guard
// and its bindings were unguarded in both directions.

export type Env = {
  /** Service binding to the `web` Worker. Used to fetch the result JSON for a
   *  permalink so web-og can render the OG card without re-running the lookup. */
  WEB: Fetcher;

  /** Shared secret for the web↔web-og Service Binding handshake. Sent on the
   *  `x-released-internal` marker header; web's isServiceBinding() compares
   *  against it and DENYs when unset (fails closed). Set via
   *  `wrangler secret put INTERNAL_SECRET`; MUST match the value set on web. */
  INTERNAL_SECRET?: string;
};
