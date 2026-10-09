import { HippoService, StoreConflictError, Vault, VaultError } from "@hippocampus/core";
import { describe, expect, it } from "vitest";
import { storeContract } from "../../core/src/store.contract.ts";
import { fixtureStore } from "../../core/src/__fixtures__/vault.ts";
import { MemoryBlobCache, gitBlobSha } from "./blob-cache.ts";
import { FakeGitHub } from "./fake-github.ts";
import { EmptyRepositoryError, GitHubStore, SnapshotCache } from "./github-store.ts";

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
    expect(gh.log()[0]!.message).toBe(`remember(campus-agent): ${r.id}\n\nHippo-Actor: agent:campus-agent`);
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

  it("reports the repo's id, visibility, default branch and pinned commit", async () => {
    const { gh, store } = await setup();
    const head = gh.refs.get("main")!;
    expect(await store.info()).toEqual({ id: gh.at(gh.repo).id, fullName: gh.repo, private: true, defaultBranch: "main", branch: "main", empty: false, head });
    expect(gh.calls).toContain("GET ");
    gh.isPrivate = false;
    await gh.push({ "notes/lisbon.md": "---\ntype: place\ntitle: Lisbon\n---\n" });
    // Still pinned: visibility is live, the head moves only on refresh.
    expect(await store.info()).toMatchObject({ private: false, head });
    await store.refresh();
    expect((await store.info()).head).toBe(gh.refs.get("main"));
  });

  it("asks a token provider for every request", async () => {
    const { gh } = await setup();
    let minted = 0;
    const store = new GitHubStore({ repo: gh.repo, fetch: gh.fetch, token: async () => `installation-${++minted}` });
    await store.list();
    expect(minted).toBeGreaterThan(0);
  });
});

describe("GitHubStore cold loads", () => {
  const many = (n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`characters/npc-${i}.md`, `---\ntype: character\ntitle: NPC ${i} João\n---\n`]));

  it("downloads a tarball instead of one blob per file", async () => {
    const deep = `lore/${"very-long-folder-name/".repeat(6)}procedure.md`;
    const { gh, store } = await setup({ ...Object.fromEntries(fixtureStore().files), ...many(40), [deep]: "# Procedure\n" });
    const vault = await Vault.load(store);
    expect(vault.entities.get("npc-7")?.fm.title).toBe("NPC 7 João");
    expect(await store.read(deep)).toBe("# Procedure\n");
    expect(gh.calls.filter((c) => c.startsWith("GET tarball/"))).toHaveLength(1);
    expect(gh.calls.filter((c) => c.startsWith("GET git/blobs/"))).toHaveLength(0);
  });

  it("fetches a few changed files one by one", async () => {
    const { gh, store } = await setup({ ...Object.fromEntries(fixtureStore().files), ...many(40) });
    await Vault.load(store);
    await gh.push({ "characters/npc-3.md": "---\ntype: character\ntitle: Renamed\n---\n" });
    await store.refresh();
    expect((await Vault.load(store)).entities.get("npc-3")?.fm.title).toBe("Renamed");
    expect(gh.calls.filter((c) => c.startsWith("GET tarball/"))).toHaveLength(1);
    expect(gh.calls.filter((c) => c.startsWith("GET git/blobs/"))).toHaveLength(1);
  });

  it("falls back to blobs when the tarball fails", async () => {
    const { gh } = await setup(many(30));
    const store = new GitHubStore({ repo: gh.repo, token: "t", fetch: (u, i) => (String(u).includes("/tarball/") ? Promise.resolve(new Response("nope", { status: 502 })) : gh.fetch(u, i)) });
    expect(await store.read("characters/npc-1.md")).toContain("NPC 1");
  });
});

describe("GitHubStore.apply with an explicit base", () => {
  it("detects changes made after the writer's base, even when the store itself is newer", async () => {
    const { gh, store: reader } = await setup();
    const base = await reader.head();
    await gh.push({ "quests/residence-permit.md": "---\ntype: quest\ntitle: Human edit\n---\n" });
    const writer = new GitHubStore({ repo: gh.repo, token: "t", fetch: gh.fetch });
    await writer.refresh();
    await expect(writer.apply([{ path: "quests/residence-permit.md", content: "stale" }], { message: "x" }, { base })).rejects.toBeInstanceOf(StoreConflictError);
    await writer.apply([{ path: "inbox/campus-agent/x.md", content: "new" }], { message: "y" }, { base });
    expect(gh.files()["quests/residence-permit.md"]).toContain("Human edit");
    expect(gh.files()["inbox/campus-agent/x.md"]).toBe("new");
  });
});

describe("GitHubStore per-request stores", () => {
  it("share caches, so a warm store costs one ref lookup", async () => {
    const { gh } = await setup();
    const cache = new MemoryBlobCache();
    const snapshots = new SnapshotCache();
    const open = () => new GitHubStore({ repo: gh.repo, token: "t", fetch: gh.fetch, cache, snapshots });
    await Vault.load(open());
    const before = gh.calls.length;
    const warm = open();
    await warm.refresh();
    await Vault.load(warm);
    expect(gh.calls.slice(before)).toEqual(["GET git/ref/heads/main"]);
  });

  it("keep their own pinned commit while another moves on", async () => {
    const { gh } = await setup();
    const snapshots = new SnapshotCache();
    const a = new GitHubStore({ repo: gh.repo, token: "t", fetch: gh.fetch, snapshots });
    const b = new GitHubStore({ repo: gh.repo, token: "t", fetch: gh.fetch, snapshots });
    await a.list();
    await gh.push({ "characters/joao-silva.md": "---\ntype: character\ntitle: João\n---\n" });
    await b.refresh();
    expect(await a.read("characters/joao-silva.md")).toBeUndefined();
    expect(await b.read("characters/joao-silva.md")).toContain("João");
  });
});

/** A GitHub App installation token provider over the fake, counting how often it was asked to refresh. */
function installationToken(gh: FakeGitHub, installation: number, body: Record<string, unknown> = {}) {
  let current: string | undefined;
  const provider = async (opts?: { refresh?: boolean }) => {
    if (opts?.refresh) provider.refreshes++;
    if (!current || opts?.refresh) {
      const res = await gh.fetch(`https://api.github.com/app/installations/${installation}/access_tokens`, { method: "POST", headers: { authorization: "Bearer app.jwt" }, body: JSON.stringify(body) });
      current = ((await res.json()) as { token: string }).token;
    }
    return current;
  };
  provider.refreshes = 0;
  return provider;
}

describe("GitHubStore tokens", () => {
  it("mints a fresh token once when the current one has expired", async () => {
    const { gh } = await setup();
    gh.requireAuth = true;
    let clock = new Date("2026-10-09T12:00:00Z");
    gh.now = () => clock;
    const installation = gh.addInstallation({ account: { id: 1, login: "player", type: "User" }, repos: [gh.repo] });
    const token = installationToken(gh, installation.id);
    const store = new GitHubStore({ repo: gh.repo, token, fetch: gh.fetch });
    await store.list();
    expect(token.refreshes).toBe(0);
    // Installation tokens last an hour.
    clock = new Date("2026-10-09T13:30:00Z");
    await store.refresh();
    await new HippoService(store, { now }).remember("home-finder", { text: "Viewing on Friday" });
    expect(token.refreshes).toBe(1);
    expect(gh.log()[0]!.message).toMatch(/^remember\(home-finder\)/);
  });

  it("gives up after one refresh", async () => {
    const { gh } = await setup();
    gh.requireAuth = true;
    const asked: (boolean | undefined)[] = [];
    const store = new GitHubStore({ repo: gh.repo, fetch: gh.fetch, token: async (o) => (asked.push(o?.refresh), "revoked") });
    await expect(store.list()).rejects.toThrow(/rejected the token/);
    expect(asked).toEqual([undefined, true]);
  });

  it("explains a rejected token without assuming where it came from", async () => {
    const { gh } = await setup();
    gh.requireAuth = true;
    const err = await new GitHubStore({ repo: gh.repo, token: "unknown", fetch: gh.fetch }).list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultError);
    expect((err as Error).message).toBe("GitHub rejected the token for player/vault (401).");
    const hinted = new GitHubStore({ repo: gh.repo, token: "unknown", fetch: gh.fetch, hint: { auth: "Check HIPPO_GITHUB_TOKEN." } });
    await expect(hinted.list()).rejects.toThrow("GitHub rejected the token for player/vault (401). Check HIPPO_GITHUB_TOKEN.");
  });

  it("says which permission a read-only token lacks", async () => {
    const { gh } = await setup();
    gh.requireAuth = true;
    gh.tokens.set("read-only", { repos: [gh.repo], permissions: { contents: "read" } });
    const store = new GitHubStore({ repo: gh.repo, token: "read-only", fetch: gh.fetch });
    expect(await store.list()).toContain("party/home-finder.md");
    await expect(store.apply([{ path: "inbox/home-finder/x.md", content: "x" }], { message: "x" })).rejects.toThrow(/needs Contents read and write on player\/vault/);
  });

  it("can't see a repo outside the token's reach", async () => {
    const { gh } = await setup();
    gh.requireAuth = true;
    gh.tokens.set("elsewhere", { repos: ["player/other"] });
    await expect(new GitHubStore({ repo: gh.repo, token: "elsewhere", fetch: gh.fetch }).info()).rejects.toThrow(/can't find player\/vault \(404\)/);
  });
});

const TEMPLATE = {
  "README.md": "# Vault\n",
  "_hippo/config.yaml": "version: 1\ncampaign: lisbon-arc\nhuman: player\n",
  "party/residency-agent.md": "---\ntype: party\ntitle: Residency Agent\n---\n",
  ".github/workflows/vault.yml": "name: vault\non: push\n",
};

describe("GitHubStore on an empty repo", () => {
  it("reports it as empty, and refuses reads with a typed error", async () => {
    const gh = await FakeGitHub.create({}, { empty: true });
    const store = new GitHubStore({ repo: gh.repo, token: "t", fetch: gh.fetch });
    expect(await store.info()).toEqual({ id: gh.at(gh.repo).id, fullName: gh.repo, private: true, defaultBranch: "main", branch: "main", empty: true, head: undefined });
    const err = await store.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmptyRepositoryError);
    expect(err).toBeInstanceOf(VaultError);
    await expect(store.apply([{ path: "a.md", content: "a" }], { message: "x" })).rejects.toBeInstanceOf(EmptyRepositoryError);
  });

  it("initializes it with README.md through the Contents API, then everything else in one commit", async () => {
    const gh = await FakeGitHub.create({}, { empty: true });
    const store = new GitHubStore({ repo: gh.repo, token: "t", fetch: gh.fetch });
    await store.initialize(TEMPLATE, { message: "chore: start the vault", author: { name: "Hippocampus", email: "hippo@example.com" } });
    expect(gh.files()).toEqual(TEMPLATE);
    const [rest, first] = gh.log();
    expect(gh.log()).toHaveLength(2);
    expect(gh.trees.get(first!.tree)!.has("README.md")).toBe(true);
    expect(gh.trees.get(first!.tree)!.size).toBe(1);
    expect(rest!.author).toEqual({ name: "Hippocampus", email: "hippo@example.com" });
    expect(gh.calls).toContain("PUT contents/README.md");
    expect(await store.read("_hippo/config.yaml")).toContain("lisbon-arc");
    expect((await store.info()).empty).toBe(false);
  });

  it("starts from the first file when there's no README", async () => {
    const gh = await FakeGitHub.create({}, { empty: true });
    const { "README.md": _, ...files } = TEMPLATE;
    await new GitHubStore({ repo: gh.repo, token: "t", fetch: gh.fetch }).initialize(files, { message: "init" });
    expect(gh.calls).toContain("PUT contents/_hippo/config.yaml");
    expect(gh.files()).toEqual(files);
  });

  it("initializes a repo created with a README as one commit", async () => {
    const gh = await FakeGitHub.create({ "README.md": "# My vault\n" });
    const store = new GitHubStore({ repo: gh.repo, token: "t", fetch: gh.fetch });
    await store.initialize(TEMPLATE, { message: "chore: start the vault" });
    expect(gh.files()).toEqual(TEMPLATE);
    expect(gh.log().map((c) => c.message)).toEqual(["chore: start the vault", "init"]);
    expect(gh.calls.some((c) => c.startsWith("PUT contents/"))).toBe(false);
  });

  it("initializes through a narrowed installation token that may write workflows", async () => {
    const gh = await FakeGitHub.create({}, { empty: true });
    await gh.addRepo({ fullName: "player/notes" });
    gh.requireAuth = true;
    const installation = gh.addInstallation({ account: { id: 1, login: "player", type: "User" }, repos: [gh.repo, "player/notes"] });
    const token = installationToken(gh, installation.id, { repository_ids: [gh.at(gh.repo).id], permissions: { contents: "write", workflows: "write" } });
    await new GitHubStore({ repo: gh.repo, token, fetch: gh.fetch }).initialize(TEMPLATE, { message: "init" });
    expect(gh.files()).toEqual(TEMPLATE);
    await expect(new GitHubStore({ repo: "player/notes", token, fetch: gh.fetch }).list()).rejects.toThrow(/can't find branch/);
  });
});

describe("GitHubStore persist filter", () => {
  /** A cache that remembers every sha it was handed, standing in for a durable one. */
  function durable() {
    const cache = new MemoryBlobCache();
    const shas = new Set<string>();
    const put = cache.put.bind(cache);
    cache.put = async (sha, content) => {
      shas.add(sha);
      await put(sha, content);
    };
    return { cache, shas };
  }

  const inbox = {
    "inbox/residency-agent/2026-09-27T140300-a1b2c3.md": "---\nagent: residency-agent\n---\nPassport number is on file\n",
    "inbox/home-finder/2026-09-28T090000-d4e5f6.md": "---\nagent: home-finder\n---\nViewing on Friday\n",
  };
  const persist = (path: string) => !path.startsWith("inbox/");

  async function inboxShas(gh: FakeGitHub) {
    return new Set([...gh.at(gh.repo).tree()].filter(([p]) => p.startsWith("inbox/")).map(([, f]) => f.sha));
  }

  for (const [how, preloadThreshold] of [
    ["from a tarball", 0],
    ["blob by blob", 1000],
  ] as const) {
    it(`keeps inbox blobs out of the durable cache when loading ${how}`, async () => {
      const { gh } = await setup({ ...Object.fromEntries(fixtureStore().files), ...inbox });
      const { cache, shas } = durable();
      const store = new GitHubStore({ repo: gh.repo, token: "t", fetch: gh.fetch, cache, persist, preloadThreshold });
      const vault = await Vault.load(store);
      expect(vault.episodes.length).toBe(2);
      expect(shas.size).toBeGreaterThan(0);
      for (const sha of await inboxShas(gh)) expect(shas.has(sha)).toBe(false);
      // Still cached, just not durably: a second load fetches nothing.
      const before = gh.calls.length;
      await Vault.load(store);
      expect(gh.calls.slice(before)).toEqual([]);
    });
  }

  it("keeps episodes it writes out of the durable cache", async () => {
    const { gh } = await setup();
    const { cache, shas } = durable();
    const transientCache = new MemoryBlobCache();
    const store = new GitHubStore({ repo: gh.repo, token: "t", fetch: gh.fetch, cache, persist, transientCache });
    const r = await new HippoService(store, { now }).remember("residency-agent", { text: "Appointment at the agency on Tuesday" });
    const sha = await gitBlobSha(gh.files()[r.path]!);
    expect(shas.has(sha)).toBe(false);
    expect(await transientCache.get(sha)).toContain("Appointment at the agency");
  });
});
