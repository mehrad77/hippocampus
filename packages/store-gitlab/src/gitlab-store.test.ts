import { HippoService, StoreConflictError, Vault, VaultError } from "@hippocampus/core";
import { EmptyRepositoryError, MemoryBlobCache, SnapshotCache } from "@hippocampus/store-git";
import { describe, expect, it } from "vitest";
import { storeContract } from "../../core/src/store.contract.ts";
import { fixtureStore } from "../../core/src/__fixtures__/vault.ts";
import { FakeGitLab } from "./fake-gitlab.ts";
import { GitLabStore } from "./gitlab-store.ts";

const now = () => new Date("2026-09-27T21:00:00.000Z");

async function setup(files?: Record<string, string>) {
  const gl = await FakeGitLab.create(files ?? Object.fromEntries(fixtureStore().files));
  const store = new GitLabStore({ project: gl.repo.id, token: "test-token", fetch: gl.fetch });
  return { gl, store };
}

storeContract("GitLabStore", async (files) => (await setup(files)).store, { ignoresEditorFiles: true });

describe("GitLabStore", () => {
  it("lists a paginated tree", async () => {
    const { gl, store } = await setup({ "a.md": "a", "inbox/residency-agent/x.md": "x", "inbox/residency-agent/y.md": "y", ".obsidian/app.json": "{}" });
    gl.pageSize = 2;
    expect(await store.list()).toEqual(["a.md", "inbox/residency-agent/x.md", "inbox/residency-agent/y.md"]);
    expect(gl.calls.filter((c) => c.startsWith("GET repository/tree")).length).toBeGreaterThan(2);
  });

  it("finds a project by its full path, nested groups included", async () => {
    const gl = await FakeGitLab.create({ "a.md": "a" }, { fullName: "harbor-university/campus/example-relocation" });
    const store = new GitLabStore({ project: "harbor-university/campus/example-relocation", token: "t", fetch: gl.fetch });
    expect(await store.list()).toEqual(["a.md"]);
  });

  it("serves repeated reads from the blob cache", async () => {
    const { gl, store } = await setup();
    await store.read("goals/residence-permit.md");
    await new GitLabStore({ project: gl.repo.id, token: "t", fetch: gl.fetch, cache: (store as unknown as { cache: MemoryBlobCache }).cache }).read("goals/residence-permit.md");
    expect(gl.calls.filter((c) => c.startsWith("GET repository/blobs/"))).toHaveLength(1);
  });

  it("writes a whole flush as one commit, with the meta's message and author", async () => {
    const { gl, store } = await setup();
    await new HippoService(store, { now }).updateQuest("residency-agent", "residence-permit", { complete: ["Book agency appointment"] });
    const [commit, parent] = gl.log();
    expect(parent!.message).toBe("init");
    expect(commit!.message).toMatch(/^goal\(residence-permit\): /);
    expect(gl.files()["goals/residence-permit.md"]).toContain("- [x] Book agency appointment");
  });

  it("reads its own commits without fetching them back", async () => {
    const { gl, store } = await setup();
    const r = await new HippoService(store, { now }).remember("campus-agent", { text: "Enrolment opens 2026-10-01" });
    const reads = gl.calls.filter((c) => c.startsWith("GET repository/blobs/")).length;
    expect(await store.read(r.path)).toContain("Enrolment opens");
    expect(gl.calls.filter((c) => c.startsWith("GET repository/blobs/")).length).toBe(reads);
  });

  it("turns removals into deletions and skips files that don't exist", async () => {
    const { gl, store } = await setup();
    await store.apply(
      [
        { path: "factions/migration-agency.md", remove: true },
        { path: "characters/nobody.md", remove: true },
      ],
      { message: "chore: prune" },
    );
    expect(gl.files()["factions/migration-agency.md"]).toBeUndefined();
    expect(gl.log()).toHaveLength(2);
  });

  it("makes no commit when nothing changes", async () => {
    const { gl, store } = await setup();
    await store.apply([{ path: "characters/nobody.md", remove: true }], { message: "noop" });
    await store.apply([{ path: "party/home-finder.md", content: gl.files()["party/home-finder.md"]! }], { message: "noop" });
    expect(gl.log()).toHaveLength(1);
  });

  it("passes the author to GitLab", async () => {
    const { gl, store } = await setup();
    await store.apply([{ path: "a.md", content: "a" }], { message: "x", author: { name: "Archivist", email: "archivist@example.test" } });
    expect(gl.log()[0]!.author).toEqual({ name: "Archivist", email: "archivist@example.test" });
  });

  it("rebases onto a concurrent push that touched other files", async () => {
    const { gl, store } = await setup();
    const service = new HippoService(store, { now });
    // The store has read the project; then someone else pushes before our commit lands.
    await store.list();
    await gl.push({ "characters/player.md": "---\ntype: character\ntitle: Player\n---\n" });
    await service.remember("home-finder", { text: "Viewing on Friday" });
    const [mine, theirs] = gl.log();
    expect(mine!.message).toMatch(/^remember\(home-finder\)/);
    expect(theirs!.message).toBe("human edit");
    expect(gl.files()["characters/player.md"]).toContain("title: Player");
  });

  it("refuses to overwrite a concurrent change to the same file", async () => {
    const { gl, store } = await setup();
    await store.list();
    await gl.push({ "goals/residence-permit.md": "---\ntype: quest\ntitle: Edited by the human\n---\n" });
    const err = await store.apply([{ path: "goals/residence-permit.md", content: "mine" }], { message: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreConflictError);
    expect((err as StoreConflictError).paths).toEqual(["goals/residence-permit.md"]);
    expect(gl.files()["goals/residence-permit.md"]).toContain("Edited by the human");
  });

  it("pins reads to one commit until refreshed", async () => {
    const { gl, store } = await setup();
    const before = (await Vault.load(store)).entities.size;
    await gl.push({ "characters/joao-silva.md": "---\ntype: character\ntitle: João Silva\n---\n" });
    expect((await Vault.load(store)).entities.size).toBe(before);
    await store.refresh();
    expect((await Vault.load(store)).entities.size).toBe(before + 1);
  });

  it("shares caches across per-request stores, so a warm store costs one branch lookup", async () => {
    const { gl } = await setup();
    const cache = new MemoryBlobCache();
    const snapshots = new SnapshotCache();
    const open = () => new GitLabStore({ project: gl.repo.id, token: "t", fetch: gl.fetch, cache, snapshots });
    await Vault.load(open());
    gl.calls.length = 0;
    await Vault.load(open());
    expect(gl.calls).toEqual(["GET repository/branches/main"]);
  });

  it("preloads from the archive when many files are missing from the cache", async () => {
    const files = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`notes/n${i}.md`, `note ${i}`]));
    const { gl } = await setup(files);
    const store = new GitLabStore({ project: gl.repo.id, token: "t", fetch: gl.fetch });
    expect(await store.read("notes/n7.md")).toBe("note 7");
    expect(gl.calls.filter((c) => c.startsWith("GET repository/archive"))).toHaveLength(1);
    expect(gl.calls.filter((c) => c.startsWith("GET repository/blobs/"))).toHaveLength(0);
  });

  it("refreshes an expired token once and retries", async () => {
    const { gl } = await setup();
    gl.tokens.add("fresh");
    const minted: (boolean | undefined)[] = [];
    let current = "stale";
    const store = new GitLabStore({
      project: gl.repo.id,
      fetch: gl.fetch,
      token: async (o) => {
        minted.push(o?.refresh);
        if (o?.refresh) current = "fresh";
        return current;
      },
    });
    expect((await store.list()).length).toBeGreaterThan(0);
    expect(minted.filter((r) => r)).toHaveLength(1);
    expect(minted.slice(0, 2)).toEqual([undefined, true]);
  });

  it("explains auth and missing-branch errors", async () => {
    const { gl } = await setup();
    await expect(new GitLabStore({ project: gl.repo.id, branch: "nope", token: "t", fetch: gl.fetch }).list()).rejects.toThrow(/can't find branch "nope"/);
    gl.tokens.add("good");
    await expect(new GitLabStore({ project: gl.repo.id, token: "bad", fetch: gl.fetch, hint: { auth: "Reconnect GitLab." } }).list()).rejects.toThrow(/rejected the token.*Reconnect GitLab\./);
    await expect(new GitLabStore({ project: 9999, token: "good", fetch: gl.fetch }).info()).rejects.toThrow(/can't find 9999/);
  });

  it("rejects malformed project names", () => {
    expect(() => new GitLabStore({ project: "just-a-name", token: "t" })).toThrow(VaultError);
  });

  describe("info", () => {
    it("reports visibility, namespace and head", async () => {
      const { gl, store } = await setup();
      const info = await store.info();
      expect(info).toMatchObject({ id: gl.repo.id, fullName: "player/example-relocation", private: true, visibility: "private", defaultBranch: "main", empty: false, namespace: { kind: "user" } });
      expect(info.head).toBe(await store.head());
    });

    it("does not treat internal projects as private", async () => {
      const gl = await FakeGitLab.create({}, { visibility: "internal" });
      const info = await new GitLabStore({ project: gl.repo.id, token: "t", fetch: gl.fetch }).info();
      expect(info).toMatchObject({ visibility: "internal", private: false });
    });
  });

  describe("an empty project", () => {
    it("reads as EmptyRepositoryError, and initialize() makes the first commit directly", async () => {
      const gl = await FakeGitLab.create({}, { empty: true });
      const store = new GitLabStore({ project: gl.repo.id, token: "t", fetch: gl.fetch });
      await expect(store.list()).rejects.toBeInstanceOf(EmptyRepositoryError);
      expect(await store.info()).toMatchObject({ empty: true, head: undefined });
      await store.initialize({ "README.md": "# Vault", "_hippo/config.yaml": "version: 1" }, { message: "chore: init vault" });
      expect(gl.log()).toHaveLength(1);
      expect(Object.keys(gl.files()).sort()).toEqual(["README.md", "_hippo/config.yaml"]);
      expect(await store.read("README.md")).toBe("# Vault");
      expect((await store.info()).empty).toBe(false);
    });
  });
});
