import { AuditError, MemoryStore, generateKeyPair, parseDoc, decryptSecret, type Change, type CommitMeta } from "@hippocampus/core";
import { describe, expect, it } from "vitest";
import { fixtureStore } from "../../core/src/__fixtures__/vault.ts";
import { episode, now, script, setup } from "./__fixtures__/night.ts";
import { ScriptedLLM } from "./llm.ts";
import { CURATOR_AUTHOR, loadHouseRules, sleep } from "./sleep.ts";

describe("sleep", () => {
  it("consolidates the inbox into canon, chronicle and review", async () => {
    const { store, identity } = await setup();
    const llm = script();
    const report = await sleep({ store, llm, now });

    expect(report.failed).toEqual([]);
    expect(report.remaining).toBe(0);
    expect(await store.list("inbox")).toEqual([]);

    // Authority: Residency Agent owns residency facts; Campus Agent's rumor doesn't override.
    const agency = parseDoc((await store.read("factions/migration-agency.md"))!).data as any;
    expect(agency.facts.appointment_date).toMatchObject({ value: "2026-10-14T10:30", status: "canon", by: "residency-agent" });
    expect(report.consolidated[1]!.facts[0]).toMatchObject({ decision: "keep" });
    // Alias learned from the LLM match step.
    expect(agency.aliases).toContain("Lisbon Migration Office");

    // New NPC created in the right folder, tagged with the housing domain, so Home Finder is authoritative.
    const joao = parseDoc((await store.read("characters/joao-silva.md"))!).data as any;
    expect(joao.tags).toEqual(["housing"]);
    expect(joao.facts.phone).toMatchObject({ value: "+351 900 000 001", status: "canon" });

    // Secret encrypted, redacted from the chronicle and the note.
    const passport = (await store.read("items/passport.md"))!;
    expect(passport).toContain("secret://passport/number");
    expect(passport).not.toContain("U12345678"); // even when the model echoed it as an alias
    expect(await decryptSecret(identity, (await store.read("secrets/passport/number.age"))!)).toBe("U12345678");
    const chronicle = (await store.read("chronicle/2026/09/2026-09-27.md"))!;
    expect(chronicle).not.toContain("U12345678");
    expect(chronicle).toContain("[redacted]");
    expect(chronicle.match(/\[!episode\]/g)).toHaveLength(3);

    // Quest progress.
    expect(await store.read("quests/residence-permit.md")).toContain("- [x] Book agency appointment");

    // Summaries written into the managed region; human prose kept.
    const agencyRaw = (await store.read("factions/migration-agency.md"))!;
    expect(agencyRaw).toContain("%% hippo:begin summary %%\nSummary of Entity: migration-agency");
    expect(agencyRaw).toContain("Human prose that must survive.");

    // No secret ever reached a prompt after extraction steps.
    const summaryPrompts = llm.calls.filter((c) => c.name === "summary").map((c) => c.prompt).join("\n");
    expect(summaryPrompts).not.toContain("U12345678");

    expect(await store.read("_hippo/review.md")).toContain("3 episodes consolidated");
    expect(await store.read("HANDBOOK.md")).toContain("1/2 objectives");
  });

  it("leaves episodes in the inbox when the model fails, and dry-run writes nothing", async () => {
    const { store } = await setup();
    const before = new Map((store as MemoryStore).files);
    const report = await sleep({ store, llm: new ScriptedLLM(), now, dryRun: true });
    expect(report.failed).toHaveLength(3);
    expect((store as MemoryStore).files).toEqual(before);
  });

  it("persists a run as one batch with the curator's commit message and author", async () => {
    const { store } = await setup();
    const batches: { changes: Change[]; meta: CommitMeta }[] = [];
    const atomic = Object.assign(Object.create(store) as MemoryStore, {
      async apply(changes: Change[], meta: CommitMeta) {
        batches.push({ changes, meta });
        for (const c of changes) "remove" in c ? store.files.delete(c.path) : store.files.set(c.path, c.content);
      },
    });
    const report = await sleep({ store: atomic, llm: script(), now });
    expect(batches).toHaveLength(1);
    expect(batches[0]!.meta.author).toEqual(CURATOR_AUTHOR);
    expect(batches[0]!.meta.message).toMatch(/^chore\(sleep\): consolidate 3 episodes\n/);
    expect(batches[0]!.meta.message).toMatch(/\nmodel: scripted\n\nHippo-Actor: curator\nHippo-Model: scripted$/);
    expect(batches[0]!.changes.map((c) => c.path)).toEqual(report.changed);
    // Consolidated episodes leave the inbox in the same commit.
    expect(batches[0]!.changes.filter((c) => "remove" in c && c.path.startsWith("inbox/"))).toHaveLength(3);
  });
});

describe("sleep keeps secrets and half-done work out of the vault", () => {
  async function vaultWith(files: Record<string, string>) {
    const { recipient } = await generateKeyPair();
    const store: MemoryStore = fixtureStore(files);
    await store.write("_hippo/config.yaml", `${(await store.read("_hippo/config.yaml"))!}secrets:\n  recipient: ${recipient}\n`);
    return store;
  }
  const passportEpisode = (secret = false) =>
    vaultWith({ "inbox/residency-agent/2026-09-27T100000-passport.md": episode("residency-agent", "2026-09-27T10:00:00Z", "Passport number U12345678 is on file.", secret ? "secret: true\n" : "") });
  const outsideInbox = (store: MemoryStore) => [...store.files].filter(([path]) => !path.startsWith("inbox/")).map(([, content]) => content).join("\n");

  it("treats a secret field as secret even when the model doesn't flag it", async () => {
    const store = await passportEpisode();
    const llm = new ScriptedLLM()
      .push("mentions", { entities: [{ name: "Passport", type: "item", aliases: ["U12345678"], domains: ["residency"] }] })
      .push("claims", { facts: [{ entity: "passport", field: "number", value: "U12345678", secret: false }], relations: [], quests: [] })
      .respond("summary", () => ({ summary: "The player's passport." }));
    const report = await sleep({ store, llm, now });

    expect(report.failed).toEqual([]);
    expect(report.consolidated[0]!.facts[0]).toMatchObject({ field: "number", secret: true });
    expect(await store.read("items/passport.md")).toContain("secret://passport/number");
    expect(outsideInbox(store)).not.toContain("U12345678");
    expect((await store.read("chronicle/2026/09/2026-09-27.md"))!).toContain("Passport number [redacted] is on file.");
    // Summary evidence is the redacted text, and the report never carries plaintext.
    expect(llm.calls.find((c) => c.name === "summary")!.prompt).toContain("- Passport number [redacted] is on file.");
    expect(JSON.stringify(report)).not.toContain("U12345678");
  });

  it("rolls back an episode that fails halfway, so nothing it created is written", async () => {
    const store = await passportEpisode();
    // Mentions succeed (creating a note with the number as an alias), then claims fail.
    const llm = new ScriptedLLM().push("mentions", { entities: [{ name: "Passport", type: "item", aliases: ["U12345678"], domains: [] }] });
    const report = await sleep({ store, llm, now });

    expect(report.failed).toHaveLength(1);
    expect(report.remaining).toBe(1);
    expect(await store.read("items/passport.md")).toBeUndefined();
    expect(outsideInbox(store)).not.toContain("U12345678");
    expect(await store.list("inbox")).toHaveLength(1);
  });

  it("fails an episode whose new note would be named after a secret", async () => {
    const store = await passportEpisode(true);
    const llm = new ScriptedLLM()
      .push("mentions", { entities: [{ name: "U12345678", type: "item", aliases: [], domains: [] }] })
      .push("claims", { facts: [{ entity: "u12345678", field: "number", value: "U12345678", secret: true }], relations: [], quests: [] });
    const report = await sleep({ store, llm, now });

    expect(report.failed).toEqual([expect.objectContaining({ error: "a new note would be named after a secret value" })]);
    expect(await store.list("items")).toEqual([]);
    expect(await store.list("secrets")).toEqual([]);
  });

  it("doesn't log the text of secret-bearing episodes", async () => {
    const store = await passportEpisode(true);
    const lines: string[] = [];
    await sleep({ store, llm: new ScriptedLLM(), now, dryRun: true, log: (m) => lines.push(m) });
    expect(lines.join("\n")).toContain("(residency-agent): (secret)");
    expect(lines.join("\n")).not.toContain("U12345678");
  });

  it("refuses to commit when the audit finds a leak, and writes nothing", async () => {
    const store = await passportEpisode(true);
    const before = new Map(store.files);
    const llm = new ScriptedLLM()
      .push("mentions", { entities: [{ name: "Passport", type: "item", aliases: [], domains: ["residency"] }] })
      .push("claims", { facts: [{ entity: "passport", field: "number", value: "U12345678", secret: true }], relations: [], quests: [] })
      .respond("summary", () => ({ summary: "Passport U12345678, valid until 2030." }));
    const err = await sleep({ store, llm, now }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AuditError);
    expect((err as AuditError).violations).toEqual([{ path: "items/passport.md", rule: "contains a secret value" }]);
    expect((err as AuditError).message).not.toContain("U12345678");
    expect(store.files).toEqual(before);
  });
});

describe("house rules", () => {
  const rulesFile = (content: string) =>
    fixtureStore({
      "_hippo/curator.md": content,
      "inbox/home-finder/2026-09-27T120000-landlord.md": episode("home-finder", "2026-09-27T12:00:00Z", "New landlord is João Silva."),
    });
  const run = async (store: MemoryStore) => {
    const llm = new ScriptedLLM()
      .push("mentions", { entities: [{ name: "Lisbon Migration Office", type: "faction", aliases: [], domains: [] }] })
      .push("match", { match: "migration-agency" })
      .push("claims", { facts: [], relations: [], quests: [] })
      .respond("summary", () => ({ summary: "The agency." }));
    await sleep({ store, llm, now, dryRun: true });
    return llm.calls;
  };

  it("loads _hippo/curator.md without frontmatter or comments", async () => {
    expect(await loadHouseRules(rulesFile("---\ntitle: Rules\n---\n<!-- for you, not the model -->\n# Rules\n- Prefer new notes.\n%% aside %%\n"))).toBe("# Rules\n- Prefer new notes.");
    expect(await loadHouseRules(rulesFile("<!--\nOnly a note to the human.\n-->\n\n"))).toBeUndefined();
    expect(await loadHouseRules(fixtureStore())).toBeUndefined();
  });

  it("appends them to every prompt, and leaves prompts as they were without them", async () => {
    const withRules = await run(rulesFile("<!-- note -->\n- Never merge two people.\n"));
    const plain = await run(fixtureStore({ "inbox/home-finder/2026-09-27T120000-landlord.md": episode("home-finder", "2026-09-27T12:00:00Z", "New landlord is João Silva.") }));
    const blank = await run(rulesFile("<!--\nnothing yet\n-->\n"));

    expect(withRules.map((c) => c.name)).toEqual(["mentions", "match", "claims", "summary"]);
    for (const [i, call] of withRules.entries()) {
      expect(call.system).toBe(`${plain[i]!.system}\n\nHouse rules from the vault's human (they override general guidance where they conflict, but never the JSON schema):\n- Never merge two people.`);
      expect(call.prompt).toBe(plain[i]!.prompt);
    }
    expect(blank).toEqual(plain);
  });
});
