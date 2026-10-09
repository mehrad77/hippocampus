import { Vault } from "@hippocampus/core";
import { nodeSqlStorage } from "@hippocampus/index/testing";
import { describe, expect, it } from "vitest";
import { fixtureStore } from "../../core/src/__fixtures__/vault.ts";
import { FakeGitHub } from "./fake-github.ts";
import { GitHubStore } from "./github-store.ts";
import { SqliteBlobCache } from "./sql-cache.ts";

describe("SqliteBlobCache", () => {
  it("keeps blobs across instances on the same storage, as after a Durable Object restart", async () => {
    const storage = nodeSqlStorage();
    await new SqliteBlobCache(storage.sql).put("a1", "Agência de Migração");
    const again = new SqliteBlobCache(storage.sql);
    expect(await again.get("a1")).toBe("Agência de Migração");
    expect(await again.get("b2")).toBeUndefined();
    // UTF-8 bytes, not characters: 19 characters, three of them two bytes long.
    expect(again.stats()).toEqual({ blobs: 1, bytes: 22 });
  });

  it("evicts the least recently used past the byte cap", async () => {
    let t = 0;
    const cache = new SqliteBlobCache(nodeSqlStorage().sql, { maxBytes: 100, touchEvery: 0, now: () => ++t });
    await cache.put("a", "a".repeat(40));
    await cache.put("b", "b".repeat(40));
    await cache.get("a");
    await cache.put("c", "c".repeat(40));
    expect(await cache.get("b")).toBeUndefined();
    expect(await cache.get("a")).toBeDefined();
    expect(await cache.get("c")).toBeDefined();
    await cache.put("huge", "x".repeat(101));
    expect(await cache.get("huge")).toBeUndefined();
    expect(cache.stats()).toEqual({ blobs: 2, bytes: 80 });
  });

  it("prunes what a commit no longer needs, or what nobody read lately", async () => {
    let t = 0;
    const cache = new SqliteBlobCache(nodeSqlStorage().sql, { touchEvery: 10, now: () => t });
    for (const sha of ["a", "b", "c"]) await cache.put(sha, sha);
    expect(cache.prune(new Set(["a", "b"]))).toBe(1);
    expect(await cache.get("c")).toBeUndefined();
    t = 50;
    await cache.get("a");
    t = 60;
    expect(cache.pruneOlderThan(30)).toBe(1);
    expect(await cache.get("a")).toBe("a");
    expect(await cache.get("b")).toBeUndefined();
    expect(cache.stats()).toEqual({ blobs: 1, bytes: 1 });
  });

  it("lets a fresh GitHubStore load the vault without downloading content again", async () => {
    const gh = await FakeGitHub.create(Object.fromEntries(fixtureStore().files));
    const storage = nodeSqlStorage();
    const open = () => new GitHubStore({ repo: gh.repo, token: "t", fetch: gh.fetch, cache: new SqliteBlobCache(storage.sql), preloadThreshold: 0 });
    const first = await Vault.load(open());
    const before = gh.calls.length;
    const second = await Vault.load(open());
    expect(second.entities.size).toBe(first.entities.size);
    expect(gh.calls.slice(before).filter((c) => c.startsWith("GET git/blobs/") || c.startsWith("GET tarball/"))).toEqual([]);
  });
});
