// Test stub for the workerd-only `cloudflare:workers` virtual module, aliased in
// vitest.config.ts. It lets vitest (Node) load @cloudflare/containers' module
// graph (Container extends DurableObject). Tests never instantiate the relay
// container, so behaviourless base classes are sufficient.

export class DurableObject<Env = unknown> {
  ctx: unknown;
  env: Env;
  constructor(ctx?: unknown, env?: Env) {
    this.ctx = ctx;
    this.env = env as Env;
  }
}

export class WorkerEntrypoint<Env = unknown> {
  ctx: unknown;
  env: Env;
  constructor(ctx?: unknown, env?: Env) {
    this.ctx = ctx;
    this.env = env as Env;
  }
}
