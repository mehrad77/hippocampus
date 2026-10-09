import { HippoService, StoreConflictError, Vault, VaultError } from "@hippocampus/core";
import { describe, expect, it } from "vitest";
import { storeContract } from "../../core/src/store.contract.ts";
import { fixtureStore } from "../../core/src/__fixtures__/vault.ts";
import { MemoryBlobCache, gitBlobSha } from "./blob-cache.ts";
import { FakeGitHub } from "./fake-github.ts";
import { GitHubStore } from "./github-store.ts";

const now = () => new Date("2026-09-27T21:00:00.000Z");

async function setup(files?: Record<string, string>) {
  const gh = await FakeGitHub.create(files ?? Object.fromEntries(fixtureStore().files));
  const store = new GitHubStore({ repo: gh.repo, token: "test-token", fetch: gh.fetch });
  return { gh, store };
}

storeContract("GitHubStore", async (files) => (await setup(files)).store, { ignoresEditorFiles: true });

describe("GitHubStore", () => {
  it("lists the walked tree when GitHub truncates the recursive listing", async () => {
    const { gh, store } = await setup({ "a.md": "a", "inbox/residency-agent/x.md": "x", ".obsidian/app.json": "{}" });
    gh.truncate = true;
    expect(await store.list()).toEqual(["a.md", "inbox/residency-agent/x.md"]);
    expect(gh.calls.some((c) => c.endsWith(":inbox"))).toBe(true);
  });

  it("serves repeated reads from the blob cache", async () => {
    const { gh, store } = await setup();
    await store.read("quests/residence-permit.md");
    await new GitHubStore({ repo: gh.repo, token: "t", fetch: gh.fetch, cache: (store as unknown as { cache: MemoryBlobCache }).cache }).read("quests/residence-permit.md");
    expect(gh.calls.filter((c) => c.startsWith("GET git/blobs/"))).toHaveLength(1);
  });

  it("computes the same blob sha as git", async () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(await gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("writes a whole flush as one commit, with the meta's message and author", async () => {
    const { gh, store } = await setup();
    const service = new HippoService(store, { now });
    await service.updateQuest("residency-agent", "residence-permit", { complete: ["Book agency appointment"] });
    const [commit, parent] = gh.log();
    expect(parent!.message).toBe("init");
    expect(commit!.message).toMatch(/^quest\(residence-permit\): /);
    const files = gh.files();
    expect(files["quests/residence-permit.md"]).toContain("- [x] Book agency appointment");
    expect(files["HANDBOOK.md"]).toBeDefined();
  });

  it("reads its own commits without fetching them back", async () => {
    const { gh, store } = await setup();
    const r = await new HippoService(store, { now }).remember("campus-agent", { text: "Enrolment opens 2026-10-01" });
    expect(gh.log()[0]!.message).toBe(`remember(campus-agent): ${r.id}`);
    const blobReads = gh.calls.filter((c) => c.startsWith("GET git/blobs/")).length;
    expect(await store.read(r.path)).toContain("Enrolment opens");
    expect(gh.calls.filter((c) => c.startsWith("GET git/blobs/")).length).toBe(blobReads);
  });

  it("turns removals into deletions and skips files that don't exist", async () => {
    const { gh, store } = await setup();
    await store.apply(
      [
        { path: "factions/migration-agency.md", remove: true },
        { path: "characters/nobody.md", remove: true },
      ],
      { message: "chore: prune" },
    );
    expect(gh.files()["factions/migration-agency.md"]).toBeUndefined();
    expect(gh.log()).toHaveLength(2);
  });

  it("makes no commit when nothing changes", async () => {
    const { gh, store } = await setup();
    await store.apply([{ path: "characters/nobody.md", remove: true }], { message: "noop" });
    await store.apply([{ path: "party/home-finder.md", content: gh.files()["party/home-finder.md"]! }], { message: "noop" });
    expect(gh.log()).toHaveLength(1);
  });

  it("rebases onto a concurrent push that touched other files", async () => {
    const { gh, store } = await setup();
    const service = new HippoService(store, { now });
    gh.beforeRefUpdate = async () => {
      gh.beforeRefUpdate = undefined;
      await gh.push({ "characters/player.md": "---\ntype: character\ntitle: Player\n---\n" });
    };
    await service.remember("home-finder", { text: "Viewing on Friday" });
    const [mine, theirs] = gh.log();
    expect(mine!.message).toMatch(/^remember\(home-finder\)/);
    expect(theirs!.message).toBe("human edit");
    expect(gh.files()["characters/player.md"]).toContain("title: Player");
  });

  it("refuses to overwrite a concurrent change to the same file", async () => {
    const { gh, store } = await setup();
    await store.list();
    await gh.push({ "quests/residence-permit.md": "---\ntype: quest\ntitle: Edited by the human\n---\n" });
    const err = await store.apply([{ path: "quests/residence-permit.md", content: "mine" }], { message: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreConflictError);
    expect((err as StoreConflictError).paths).toEqual(["quests/residence-permit.md"]);
    expect(gh.files()["quests/residence-permit.md"]).toContain("Edited by the human");
  });

  it("redoes a quest update on fresh state after a conflict", async () => {
    const { gh, store } = await setup();
    gh.beforeRefUpdate = async () => {
      gh.beforeRefUpdate = undefined;
      const quest = gh.files()["quests/residence-permit.md"]!;
      await gh.push({ "quests/residence-permit.md": quest.replace("title: Residence permit 2026", "title: Residence permit (renewal)") });
    };
    await store.refresh();
    await new HippoService(store, { now }).updateQuest("residency-agent", "residence-permit", { complete: ["Get health insurance"] });
    const quest = gh.files()["quests/residence-permit.md"]!;
    expect(quest).toContain("title: Residence permit (renewal)");
    expect(quest).toContain("- [x] Get health insurance");
  });

  it("pins reads to one commit until refreshed", async () => {
    const { gh, store } = await setup();
    const before = (await Vault.load(store)).entities.size;
    await gh.push({ "characters/joao-silva.md": "---\ntype: character\ntitle: João Silva\n---\n" });
    expect((await Vault.load(store)).entities.size).toBe(before);
    await store.refresh();
    expect((await Vault.load(store)).entities.size).toBe(before + 1);
  });

  it("explains auth and missing-branch errors", async () => {
    const { gh } = await setup();
    const missing = new GitHubStore({ repo: gh.repo, branch: "nope", token: "t", fetch: gh.fetch });
    await expect(missing.list()).rejects.toThrow(/can't find branch "nope"/);
    const denied = new GitHubStore({ repo: gh.repo, token: "t", fetch: async () => new Response("{}", { status: 401 }) });
    await expect(denied.list()).rejects.toBeInstanceOf(VaultError);
    expect(() => new GitHubStore({ repo: "not a repo", token: "t" })).toThrow(/owner\/name/);
  });

  it("asks a token provider for every request", async () => {
    const { gh } = await setup();
    let minted = 0;
    const store = new GitHubStore({ repo: gh.repo, fetch: gh.fetch, token: async () => `installation-${++minted}` });
    await store.list();
    expect(minted).toBeGreaterThan(0);
  });
});
