import { signWebhook } from "@hippocampus/store-github/testing";
import { createHostedApp, type HostedAppDeps } from "../app.ts";
import { keyRequest } from "../hosted/registry.ts";
import { APP, ORIGIN, appKeyPair, hostedGitHub, registryDb, testSettings } from "../hosted/testing.ts";
import type { DashboardUser, PartyMember, VaultGrant, VaultHosts, VaultMeta, VaultStub } from "../hosted/vault-port.ts";
import { browser } from "./browser.ts";
import { MemoryKV } from "./memory-kv.ts";

// The whole hosted Worker in Node: the real routes, registry, sessions and OAuth provider, against
// FakeGitHub, with each vault's Durable Object replaced by a recorder.

export const PLAYER = { login: "player", id: 4242, repo: 9001 };
/** An admin. */
export const GM = { login: "game-master", id: 7, repo: 9002 };
export const SCOUT = { login: "job-scout", id: 5150, repo: 9003 };
export const SETTINGS = { campaign: "Lisbon relocation", human: "player", timezone: "Europe/Lisbon", domains: ["residency", "housing"] };

export type Visit = ReturnType<typeof browser>;

export interface StubCall {
  vault: string;
  method: "configure" | "mcp" | "dashboard" | "party" | "addParty" | "disconnect" | "destroy";
  meta?: VaultMeta;
  grant?: VaultGrant;
  user?: DashboardUser;
  path?: string;
  /** Credentials the stub was handed (it should get none). */
  authorization?: string | null;
  cookie?: string | null;
  input?: { id: string; title: string };
  via?: string;
  reason?: string;
}

/** Each vault's Durable Object, as a recorder: every call, and a party per vault. */
export class FakeVaults implements VaultHosts {
  readonly calls: StubCall[] = [];
  readonly parties = new Map<string, PartyMember[]>();

  get(vault: string): VaultStub {
    const seen = (call: Omit<StubCall, "vault">) => void this.calls.push({ vault, ...call });
    const creds = (r: Request) => ({ authorization: r.headers.get("authorization"), cookie: r.headers.get("cookie") });
    return {
      configure: async (meta) => seen({ method: "configure", meta }),
      mcp: async (request, grant) => {
        seen({ method: "mcp", grant, ...creds(request) });
        return Response.json({ vault, grant, body: await request.text() });
      },
      dashboard: async (request, user) => {
        const path = new URL(request.url).pathname;
        seen({ method: "dashboard", user, path, ...creds(request) });
        return Response.json({ vault, user, path });
      },
      party: async () => {
        seen({ method: "party" });
        return this.parties.get(vault) ?? [];
      },
      addParty: async (input, via) => {
        seen({ method: "addParty", input, via });
        if (input.id === "player") throw new Error(`"player" is the vault's human, not an agent`);
        this.parties.set(vault, [...(this.parties.get(vault) ?? []), { id: input.id, title: input.title }]);
        return { slug: input.id };
      },
      disconnect: async (reason) => seen({ method: "disconnect", reason }),
      destroy: async () => seen({ method: "destroy" }),
    };
  }

  /** The calls to one vault, optionally of one method. */
  to(vault: string, method?: StubCall["method"]): StubCall[] {
    return this.calls.filter((c) => c.vault === vault && (!method || c.method === method));
  }
}

/** The asset store, enough of it: `index.html` for directories, `.html` for extensionless paths. */
export function fakeAssets(files: Record<string, string>) {
  return {
    async fetch(request: Request) {
      const { pathname } = new URL(request.url);
      const body = files[pathname.endsWith("/") ? `${pathname}index.html` : `${pathname}.html`] ?? files[pathname];
      if (body === undefined && files[`${pathname}/index.html`]) return new Response(null, { status: 307, headers: { location: `${pathname}/` } });
      if (body === undefined) return new Response("Not Found", { status: 404 });
      const type = pathname.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8";
      return new Response(body, { headers: { "content-type": type, "cache-control": "public, max-age=0, must-revalidate" } });
    },
  };
}

let keyPair: ReturnType<typeof appKeyPair> | undefined;

export async function hostedApp(opts: { limits?: HostedAppDeps["limits"] } = {}) {
  const keys = await (keyPair ??= appKeyPair());
  const github = await hostedGitHub(keys);
  const { gh } = github;
  for (const u of [PLAYER, GM, SCOUT]) gh.addUser({ login: u.login, id: u.id });
  await gh.addRepo({ fullName: "game-master/vault", id: GM.repo, empty: true });
  await gh.addRepo({ fullName: "job-scout/vault", id: SCOUT.repo, empty: true });
  const kv = new MemoryKV();
  const vaults = new FakeVaults();
  const logs: string[] = [];
  const app = createHostedApp({
    settings: testSettings(keys.privateKeyPem, [GM.id]),
    kv,
    registry: await registryDb(),
    vaults,
    assets: fakeAssets({
      "/dashboard/index.html": "<!doctype html><title>Tavern</title>",
      "/dashboard/welcome/index.html": "<!doctype html><title>Welcome</title>",
      "/dashboard/404.html": "<!doctype html><title>Lost</title>",
    }),
    fetch: github.fetch,
    limits: opts.limits,
    log: (line) => logs.push(line),
  });
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException() {} };
  const send = (request: Request) => app.fetch(request, ctx);
  const registry = app.routes.registry;

  const signIn = async (using: Visit, login: string) => {
    const toGitHub = await using(`${ORIGIN}/dashboard/auth/login`);
    return using(github.signIn(toGitHub.headers.get("location")!, login));
  };
  const api = (using: Visit, path: string, init: { method?: string; json?: unknown; headers?: Record<string, string> } = {}) => {
    const headers = new Headers(init.headers);
    if (init.json !== undefined) headers.set("content-type", "application/json");
    return using(`${ORIGIN}/dashboard/api/${path}`, { method: init.method ?? "GET", headers, body: init.json === undefined ? undefined : JSON.stringify(init.json) });
  };
  const post = (using: Visit, path: string, json: unknown, headers: Record<string, string> = { origin: ORIGIN }) => api(using, path, { method: "POST", json, headers });

  /** Signed in, approved, the app installed on `<login>/vault`, and the vault set up through the API. */
  const readyAccount = async (who: { login: string; id: number; repo: number }) => {
    const visit = browser(send);
    await signIn(visit, who.login);
    await registry.setAccountStatus(who.id, "approved");
    const installation = gh.addInstallation({ account: { id: who.id, login: who.login, type: "User" }, repos: [`${who.login}/vault`] });
    await visit(github.installed(who.login, installation.id));
    const init = await post(visit, "setup/init", { repoId: who.repo, ...SETTINGS, human: who.login });
    if (init.status !== 200) throw new Error(`setup/init: ${init.status} ${await init.text()}`);
    const { vault } = (await init.json()) as { vault: { id: string } };
    return { visit, vault: vault.id, installation };
  };

  /** A vault key, minted straight into the registry. */
  const mintKey = async (vault: string, body: unknown) => (await registry.mintKey(vault, keyRequest(body))).token;

  /** One MCP request with a bearer token. The fake stub echoes what it got. */
  const callMcp = (token: string, body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', headers: Record<string, string> = {}) =>
    send(new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body }));

  /** A signed delivery of GitHub's webhook. */
  let deliveries = 0;
  const deliver = async (event: string, payload: unknown) => {
    const body = JSON.stringify(payload);
    const headers = { "x-github-event": event, "x-github-delivery": `d-${++deliveries}`, "x-hub-signature-256": await signWebhook(APP.webhookSecret, body) };
    const res = await send(new Request(`${ORIGIN}/github/webhook`, { method: "POST", body, headers }));
    if (res.status !== 200) throw new Error(`webhook: ${res.status}`);
    return res;
  };

  return { app, gh, github, kv, vaults, logs, waits, send, registry, signIn, api, post, readyAccount, mintKey, callMcp, deliver, browser: () => browser(send) };
}

export type HostedHarness = Awaited<ReturnType<typeof hostedApp>>;
