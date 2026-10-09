import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_PATH, HippoService, type VaultStore } from "@hippocampus/core";
import { FsStore } from "@hippocampus/core/node";
import { HttpError, serviceSource, type DashboardSource, type Mode, type VaultInfo } from "@hippocampus/dashboard";
import { buildDemoStore } from "@hippocampus/dashboard/demo";
import { connectMcp, mcpSource } from "@hippocampus/dashboard/mcp";
import { GitHubStore } from "@hippocampus/store-github";
import { expandHome, indexKey, type Env } from "../paths.ts";
import { openIndex, openStore, parseRepo, type OpenIndex } from "../stores.ts";

/** What the dashboard is looking at, and how to open it again. Tokens stay in memory only. */
export type VaultTarget =
  | { kind: "dir"; dir: string }
  | { kind: "github"; repo: string; token?: string }
  | { kind: "mcp"; url: string; token?: string }
  | { kind: "demo" };

export interface ActiveVault {
  mode: Mode;
  vault: VaultInfo;
  target: VaultTarget;
  source: DashboardSource;
  /** Local and GitHub vaults (and the demo): the store and service behind the source. */
  store?: VaultStore;
  service?: HippoService;
  index?: OpenIndex;
  close(): Promise<void>;
}

export interface OpenOptions {
  env: Env;
  /** Use the persistent search index (`--no-index` turns it off). */
  index: boolean;
  /** Where `seeds/` lives, for the demo. */
  assets: string;
  log?: (msg: string) => void;
}

/** Open a vault for the dashboard. Fails early (bad path, token or URL) so the old one stays in place. */
export async function openVault(target: VaultTarget, opts: OpenOptions): Promise<ActiveVault> {
  switch (target.kind) {
    case "demo": {
      const store = await buildDemoStore(new FsStore(join(opts.assets, "seeds", "example-relocation")));
      const service = new HippoService(store);
      const vault: VaultInfo = { kind: "memory" };
      return { mode: "demo", vault, target, store, service, source: serviceSource(service, { mode: "demo", vault }), close: async () => {} };
    }
    case "dir": {
      const dir = resolve(expandHome(target.dir));
      if (!existsSync(join(dir, CONFIG_PATH))) throw new HttpError(400, `${dir} has no ${CONFIG_PATH}; is it a vault?`, "NOT_A_VAULT");
      const store = new FsStore(dir);
      const vault: VaultInfo = { kind: "dir", dir };
      return withService({ mode: "local", vault, target: { kind: "dir", dir }, store }, indexKey({ dir }), opts);
    }
    case "github": {
      const store = openStore({ github: target.repo, token: target.token, env: opts.env }) as GitHubStore;
      try {
        if ((await store.read(CONFIG_PATH)) === undefined) throw new HttpError(400, `${store.repo} has no ${CONFIG_PATH} on ${store.branch}; is it a vault?`, "NOT_A_VAULT");
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, `Couldn't read ${parseRepo(target.repo).repo} on GitHub: ${err instanceof Error ? err.message : String(err)}`, "GITHUB");
      }
      const vault: VaultInfo = { kind: "github", repo: store.repo, branch: store.branch };
      return withService({ mode: "github", vault, target, store }, indexKey({ github: target.repo }), opts);
    }
    case "mcp": {
      let client;
      try {
        client = await connectMcp(target.url, { token: target.token });
      } catch (err) {
        throw new HttpError(502, `Couldn't connect to ${target.url}: ${err instanceof Error ? err.message : String(err)}`, "UPSTREAM");
      }
      const source = await mcpSource(client, { url: target.url });
      return { mode: "mcp", vault: { kind: "mcp", url: target.url }, target, source, close: () => client.close() };
    }
  }
}

async function withService(base: Omit<ActiveVault, "source" | "service" | "close">, key: string, opts: OpenOptions): Promise<ActiveVault> {
  let index: OpenIndex | undefined;
  if (opts.index) {
    try {
      index = await openIndex(key, opts.env);
    } catch (err) {
      // The index is a cache: a broken embedding setting shouldn't keep the vault closed.
      opts.log?.(`⚠ search index unavailable, using in-memory search: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const service = new HippoService(base.store!, { searcher: index?.index.searcher });
  const source = serviceSource(service, { mode: base.mode, vault: base.vault });
  return { ...base, service, index, source, close: async () => index?.close() };
}

/** The dashboard's current vault. Setup switches it in place, without a restart. */
export class DashboardRuntime {
  private active?: ActiveVault;

  constructor(private readonly opts: OpenOptions) {}

  get current(): DashboardSource | undefined {
    return this.active?.source;
  }

  get vault(): ActiveVault | undefined {
    return this.active;
  }

  /** Open `target` and make it current; the previous vault's index and connections are closed. */
  async open(target: VaultTarget): Promise<ActiveVault> {
    const next = await openVault(target, this.opts);
    await this.use(next);
    return next;
  }

  /** Reopen the current vault, e.g. after its search settings changed. */
  async reopen(): Promise<void> {
    if (this.active && this.active.target.kind !== "demo") await this.open(this.active.target);
  }

  async use(next: ActiveVault | undefined): Promise<void> {
    const prev = this.active;
    this.active = next;
    if (prev && prev !== next) await prev.close().catch(() => {});
  }

  async close(): Promise<void> {
    await this.use(undefined);
  }
}
