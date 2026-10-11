import { describe, expect, it } from "vitest";
import { MANAGED_CONFIG, managedStore } from "./__fixtures__/managed.ts";
import { auditChanges } from "./audit.ts";
import { identify, matchIdentity } from "./identity.ts";
import { parseDoc, renderDoc } from "./markdown.ts";
import { applyFact, applyRuling, applyRulings, declineProposal } from "./ops.ts";
import { generateKeyPair, isSecretRef, secretPath, secretRef } from "./secrets.ts";
import type { MemoryStore } from "./store.ts";
import { Vault, VaultError } from "./vault.ts";

const now = () => new Date("2026-09-27T12:00:00.000Z");
const at = "2026-09-20T10:00:00.000Z";
const load = (store: MemoryStore) => Vault.load(store, { now });
const SLUG = "proposal-landlord-stakes";

/** The human edits a dispute note in Obsidian. */
async function humanEdits(store: MemoryStore, slug: string, patch: Record<string, unknown>): Promise<void> {
  const path = `disputes/${slug}.md`;
  const { data, body } = parseDoc((await store.read(path))!);
  await store.write(path, renderDoc({ ...data, ...patch }, body));
}

describe("proposals", () => {
  it("files someone else's value for a human-only field as a proposal, and a ruling applies it", async () => {
    const store = managedStore();
    const v = await load(store);
    const landlord = v.resolve("landlord")!;
    const r = await applyFact(v, landlord, "stakes", "high", { by: "home-finder", at, src: ["ep-1"] }, { evidence: "said so on the phone", confidence: 0.7 });
    expect(r.decision).toBe("propose");
    await applyFact(v, landlord, "stakes", "high", { by: "home-finder", at, src: ["ep-2"] });
    expect(landlord.fm.facts.stakes).toBeUndefined();
    const d = v.disputes.get(SLUG)!;
    expect(d.fm).toMatchObject({ kind: "proposal", state: "pending", status: "open", evidence: "said so on the phone", claims: [{ value: "high", by: "home-finder", src: ["ep-1", "ep-2"] }] });
    expect(d.body).toContain("Proposed value for **stakes** of [[landlord]]");
    expect(d.body).toContain("`state: declined`");
    await v.flush();

    await humanEdits(store, SLUG, { ruling: "high" });
    const night = await load(store);
    expect(applyRulings(night)).toEqual(["landlord.stakes = high"]);
    expect(night.resolve("landlord")!.fm.facts.stakes).toMatchObject({ value: "high", status: "canon", by: "player", src: ["ep-1", "ep-2"] });
    expect(night.disputes.get(SLUG)!.fm).toMatchObject({ status: "resolved", state: "applied" });
    expect(await auditChanges({ before: store, changes: night.changes(), actor: { kind: "curator" } })).toEqual([]);
  });

  it("declines: the note closes and nothing changes; the same value isn't raised again, another is", async () => {
    const store = managedStore();
    const v = await load(store);
    await applyFact(v, v.resolve("landlord")!, "stakes", "high", { by: "home-finder", at, src: ["ep-1"] });
    await v.flush();
    await humanEdits(store, SLUG, { state: "declined" });

    const night = await load(store);
    expect(applyRulings(night)).toEqual(["landlord.stakes: declined"]);
    const landlord = night.resolve("landlord")!;
    expect(landlord.fm.facts.stakes).toBeUndefined();
    expect(night.disputes.get(SLUG)!.fm).toMatchObject({ status: "resolved", state: "declined" });
    await applyFact(night, landlord, "stakes", "high", { by: "job-scout", at, src: ["ep-3"] });
    expect(night.disputes.get(SLUG)!.fm).toMatchObject({ status: "resolved", state: "declined" });
    await applyFact(night, landlord, "stakes", "low", { by: "job-scout", at, src: ["ep-4"] });
    expect(night.disputes.get(SLUG)!.fm).toMatchObject({ status: "open", state: "pending" });
    declineProposal(night, night.disputes.get(SLUG)!);
    expect(night.disputes.get(SLUG)!.fm).toMatchObject({ status: "resolved", state: "declined" });
    expect(night.resolve("landlord")!.fm.facts.stakes).toBeUndefined();
  });

  it("closes as already_present when the human holds the value", async () => {
    const store = managedStore();
    const v = await load(store);
    const landlord = v.resolve("landlord")!;
    await applyFact(v, landlord, "stakes", "low", { by: "home-finder", at, src: ["ep-1"] });
    // The human sets it themselves before ruling.
    await applyFact(v, landlord, "stakes", "low", { by: "player", at, src: ["ep-2"] });
    expect(applyRulings(v)).toEqual(["landlord.stakes: already present"]);
    expect(v.disputes.get(SLUG)!.fm).toMatchObject({ status: "resolved", state: "already_present" });
    expect(v.disputes.get(SLUG)!.body).not.toContain("Your call");

    const d = v.openProposal(landlord, "stakes", { value: "low", by: "job-scout", src: ["ep-3"] });
    expect(d.fm).toMatchObject({ status: "resolved", state: "already_present" });
    expect(d.body).toContain("Already present");
  });

  it("keeps a secret proposal for a human-only field encrypted beside the field's own secret", async () => {
    const { recipient } = await generateKeyPair();
    const store = managedStore({ "_hippo/config.yaml": `${MANAGED_CONFIG}secrets: { recipient: ${recipient} }\n` });
    const v = await load(store);
    const landlord = v.resolve("landlord")!;
    expect((await applyFact(v, landlord, "pin", "4321", { by: "home-finder", at, src: ["ep-9"] })).decision).toBe("propose");
    const path = "secrets/landlord/pin.ep-9.age";
    expect(secretPath("secrets", secretRef("landlord", "pin"), "ep-9")).toBe(path);
    const d = v.disputes.get("proposal-landlord-pin")!;
    const claim = d.fm.claims[0]!;
    expect(claim.value).toBe("secret://landlord/pin.ep-9");
    expect(isSecretRef(claim.value) && secretPath("secrets", claim.value)).toBe(path);
    expect(landlord.fm.facts.pin).toBeUndefined();
    const changes = v.changes();
    const file = changes.find((c) => c.path === path);
    expect(file && "content" in file && file.content.startsWith("-----BEGIN AGE ENCRYPTED FILE-----")).toBe(true);
    expect(JSON.stringify(changes)).not.toContain("4321");
    await v.flush();

    await humanEdits(store, "proposal-landlord-pin", { ruling: claim.value });
    const night = await load(store);
    applyRulings(night);
    expect(night.resolve("landlord")!.fm.facts.pin).toMatchObject({ value: "secret://landlord/pin.ep-9", status: "canon", by: "player" });
    expect(await auditChanges({ before: store, changes: night.changes(), actor: { kind: "curator" } })).toEqual([]);
  });
});

describe("identity keys and merges", () => {
  it("matches identity keys folded, and never by name alone", async () => {
    const v = await load(managedStore());
    expect(matchIdentity(v, "character", { email: " Landlord@Lisbon.example " }).map((m) => [m.entity.slug, m.field])).toEqual([["landlord", "email"]]);
    expect(matchIdentity(v, "character", { "email@work": "landlord@lisbon.example" })).toHaveLength(1);
    expect(matchIdentity(v, "character", { title: "The landlord" })).toEqual([]);
    expect(matchIdentity(v, "faction", { email: "landlord@lisbon.example" })).toEqual([]);
    expect(identify(v, "character", undefined, { email: "landlord@lisbon.example" })).toMatchObject({ entity: { slug: "landlord" }, via: "key" });
    expect(identify(v, "character", v.resolve("landlord"), { email: "landlord@lisbon.example" })).toEqual({ entity: v.resolve("landlord"), via: "name" });
    expect(identify(v, "character", undefined, { email: "nobody@lisbon.example" })).toEqual({});
  });

  it("raises a merge proposal when a name and an identity key point at different notes", async () => {
    const store = managedStore();
    const v = await load(store);
    const player = v.resolve("player")!;
    const r = identify(v, "character", player, { email: "landlord@lisbon.example" });
    expect(r.entity?.slug).toBe("player");
    expect(r.merge?.slug).toBe("merge-landlord-player");
    expect(r.merge?.fm).toMatchObject({ kind: "merge", state: "pending", status: "open", field: "email", targets: ["[[landlord]]", "[[player]]"] });
    expect(r.merge?.body).toContain("may be the same");
    expect(() => applyRuling(v, r.merge!, "yes")).toThrow(VaultError);
    await v.flush();
    const raw = (await store.read("disputes/merge-landlord-player.md"))!;
    expect(parseDoc(raw).data).toMatchObject({ type: "dispute", kind: "merge" });

    await humanEdits(store, "merge-landlord-player", { state: "declined" });
    const night = await load(store);
    applyRulings(night);
    expect(night.disputes.get("merge-landlord-player")!.fm).toMatchObject({ status: "resolved", state: "declined" });
    expect(identify(night, "character", night.resolve("player"), { email: "landlord@lisbon.example" }).merge?.fm.status).toBe("resolved");
  });

  it("refuses to decline a conflict between sources", async () => {
    const v = await load(managedStore());
    const agency = v.resolve("migration-agency")!;
    await applyFact(v, agency, "office", "Alfama", { by: "job-scout", at, src: ["ep-1"] });
    await applyFact(v, agency, "office", "Belém", { by: "home-finder", at, src: ["ep-2"] });
    expect(() => declineProposal(v, v.openDisputes()[0]!)).toThrow(/needs a ruling/);
  });
});

describe("audit: human-only fields", () => {
  it("refuses a human-only value without a ruling or the human's episode", async () => {
    const store = managedStore();
    const landlord = (await store.read("characters/landlord.md"))!;
    const withStakes = (by: string, src: string) => landlord.replace("facts:\n", `facts:\n  stakes: { value: high, status: canon, by: ${by}, src: [${src}] }\n`);
    expect(await auditChanges({ before: store, changes: [{ path: "characters/landlord.md", content: withStakes("home-finder", "ep-1") }], actor: { kind: "curator" } })).toEqual([
      { path: "characters/landlord.md", rule: "human-only field changed: stakes" },
    ]);
    const episode = "inbox/player/2026-09-27T100000-stakes.md";
    await store.write(episode, "---\nid: ep-h\nagent: player\nat: 2026-09-27T10:00:00Z\n---\nThe landlord's stakes are high.\n");
    const v = await load(store);
    await v.appendChronicle(v.episodes[0]!, ["landlord"]);
    v.archiveEpisode(v.episodes[0]!);
    const changes = [...v.changes(), { path: "characters/landlord.md", content: withStakes("player", "ep-h") }];
    expect(await auditChanges({ before: store, changes, actor: { kind: "curator" } })).toEqual([]);
  });
});
