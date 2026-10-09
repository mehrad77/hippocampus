import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "./types.ts";

/** A Map-backed Storage, so the cache can run under Node. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

const caps = { rule: true, quest: true, remember: true, party: true, introductions: true, setup: "hosted", curator: true } as const;
const session = (login: string, repo: string): SessionInfo => ({ mode: "worker", user: { login }, vault: { kind: "github", repo }, capabilities: caps });

let responses: Record<string, unknown>;
let session$: Storage;
let local$: Storage;

/** A fresh copy of the cache module over the current storages and fake API. */
async function load() {
  vi.resetModules();
  return import("./cache.ts");
}

beforeEach(() => {
  session$ = memoryStorage();
  local$ = memoryStorage();
  responses = {};
  vi.stubGlobal("sessionStorage", session$);
  vi.stubGlobal("localStorage", local$);
  vi.stubGlobal("fetch", async (url: string) => {
    const path = String(url).replace(/^.*\/api/, "");
    const body = responses[path];
    return body === undefined ? new Response(JSON.stringify({ error: "Sign in", code: "SIGN_IN" }), { status: 401 }) : new Response(JSON.stringify(body), { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cache scoping", () => {
  it("names the user, the vault and the mode in the scope", async () => {
    const { scopeOf, storageKey } = await load();
    expect(scopeOf(session("player", "player/lisbon-arc"))).not.toBe(scopeOf(session("player-two", "player/lisbon-arc")));
    expect(scopeOf(session("player", "player/lisbon-arc"))).not.toBe(scopeOf(session("player", "player/harbor-notes")));
    expect(scopeOf({ mode: "setup", user: { login: "player" } })).not.toBe(scopeOf(session("player", "player/lisbon-arc")));
    expect(storageKey("/overview", "a")).not.toBe(storageKey("/overview", "b"));
    expect(storageKey("/overview", undefined)).toBeUndefined();
  });

  it("keeps one account's copies for the next page of the same account", async () => {
    responses = { "/session": session("player", "player/lisbon-arc"), "/overview": { campaign: "lisbon-arc" } };
    let cache = await load();
    await cache.revalidate("/session");
    await cache.revalidate("/overview");
    cache = await load();
    expect(cache.peek("/overview").data).toEqual({ campaign: "lisbon-arc" });
  });

  it("never paints one account's data for another, and drops it once the new session arrives", async () => {
    responses = { "/session": session("player", "player/lisbon-arc"), "/overview": { campaign: "lisbon-arc" } };
    let cache = await load();
    await cache.revalidate("/session");
    await cache.revalidate("/overview");

    // Another account signs in in this tab (say, after its cookie changed elsewhere).
    responses = { "/session": session("player-two", "player-two/harbor-notes"), "/overview": { campaign: "harbor-notes" } };
    cache = await load();
    await cache.revalidate("/session");
    expect(cache.peek("/overview").data).toBeUndefined();
    expect([...Array(session$.length).keys()].map((i) => session$.key(i)).some((k) => k?.includes("lisbon-arc#"))).toBe(false);
    await cache.revalidate("/overview");
    expect(cache.peek("/overview").data).toEqual({ campaign: "harbor-notes" });
  });

  it("drops copies when the vault changes under the same account", async () => {
    responses = { "/session": { mode: "setup", user: { login: "player" }, capabilities: caps }, "/setup/status": { kind: "hosted", step: 1 } };
    const cache = await load();
    await cache.revalidate("/session");
    await cache.revalidate("/setup/status");
    responses["/session"] = session("player", "player/lisbon-arc");
    await cache.revalidate("/session");
    expect(cache.peek("/setup/status").data).toBeUndefined();
  });

  it("signing out wipes this tab and makes other tabs' copies stale", async () => {
    responses = { "/session": session("player", "player/lisbon-arc"), "/overview": { campaign: "lisbon-arc" } };
    let cache = await load();
    await cache.revalidate("/session");
    await cache.revalidate("/overview");
    // A second tab's storage holds the same copies.
    const otherTab = memoryStorage();
    for (let i = 0; i < session$.length; i++) otherTab.setItem(session$.key(i)!, session$.getItem(session$.key(i)!)!);

    cache.clearCache({ everywhere: true });
    expect(session$.length).toBe(1); // only the meta (scope cleared) remains
    expect(cache.peek("/session").data).toBeUndefined();

    vi.stubGlobal("sessionStorage", otherTab);
    cache = await load();
    expect(cache.peek("/session").data).toBeUndefined();
    expect(cache.peek("/overview").data).toBeUndefined();
  });

  it("forgets everything on a 401 without touching other tabs", async () => {
    responses = { "/session": session("player", "player/lisbon-arc"), "/overview": { campaign: "lisbon-arc" } };
    const cache = await load();
    await cache.revalidate("/session");
    await cache.revalidate("/overview");
    const epoch = local$.getItem("hippo:cache-epoch");
    responses = {};
    await cache.revalidate("/session");
    expect(cache.peek("/session").error?.status).toBe(401);
    expect(cache.peek("/overview").data).toBeUndefined();
    expect(local$.getItem("hippo:cache-epoch")).toBe(epoch);
  });
});
