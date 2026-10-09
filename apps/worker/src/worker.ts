import { d1 } from "@hippocampus/index";
import { configProblem, createHostedApp, type HostedApp } from "./app.ts";
import type { HostedEnv } from "./hosted/env.ts";
import { hostedSettings } from "./hosted/settings.ts";
import type { VaultHosts } from "./hosted/vault-port.ts";

// The hosted Worker: accounts, onboarding and OAuth here; each vault in its own Durable Object.

export { VaultHost } from "./hosted/vault-host.ts";

/** Per isolate, shared by its requests. */
let app: HostedApp | undefined;

export default {
  async fetch(request, env, ctx) {
    if (!app) {
      const problem = configProblem(env);
      if (problem) return problem;
      // Typed against the port, so the compiler holds VaultHost's RPC methods to what the Worker calls.
      const vaults: VaultHosts = { get: (id) => env.VAULT_HOST.get(env.VAULT_HOST.idFromName(id)) };
      app = createHostedApp({
        settings: hostedSettings(env),
        kv: env.OAUTH_KV,
        registry: d1(env.REGISTRY),
        vaults,
        assets: env.ASSETS,
        limits: { signIn: env.RL_SIGNIN, api: env.RL_API, mcp: env.RL_MCP, register: env.RL_REGISTER },
      });
    }
    return app.fetch(request, ctx);
  },
} satisfies ExportedHandler<HostedEnv>;
