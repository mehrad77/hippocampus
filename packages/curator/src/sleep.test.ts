import { CURRENT_VAULT_VERSION, MemoryStore, Vault, decryptSecret, generateKeyPair, hash, normalizeName, parseDoc, readFailures, searchDocs, type Change, type CommitMeta } from "@hippocampus/core";
import { describe, expect, it } from "vitest";
import { fixtureStore } from "../../core/src/__fixtures__/vault.ts";
import { episode, now, script, setup } from "./__fixtures__/night.ts";
import { ScriptedLLM } from "./llm.ts";
import { claimsSchema } from "./prompts.ts";
import { CURATOR_AUTHOR, SET_ASIDE_AFTER, describeEpisode, loadHouseRules, pickBatch, sleep } from "./sleep.ts";

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
    expect(await store.read("goals/residence-permit.md")).toContain("- [x] Book agency appointment");

    // Summaries written into the managed region; human prose kept.
    const agencyRaw = (await store.read("factions/migration-agency.md"))!;
    expect(agencyRaw).toContain("%% hippo:begin summary %%\nSummary of Entity: migration-agency");
    expect(agencyRaw).toContain("Human prose that must survive.");

    // No secret ever reached a prompt after extraction steps.
    const summaryPrompts = llm.calls.filter((c) => c.name === "summary").map((c) => c.prompt).join("\n");
    expect(summaryPrompts).not.toContain("U12345678");

    expect(await store.read("_hippo/review.md")).toContain("3 episodes consolidated");
    // A domain the model wanted is suggested; one from the secret-bearing episode isn't.
    expect(parseDoc((await store.read("_hippo/review.md"))!).data.suggested_domains).toEqual(["rentals"]);
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

  it("keeps no secret in the review's failure record, only the rule", async () => {
    const store = await passportEpisode(true);
    const llm = new ScriptedLLM()
      .push("mentions", { entities: [{ name: "U12345678", type: "item", aliases: [], domains: [] }] })
      .push("claims", { facts: [{ entity: "u12345678", field: "number", value: "U12345678", secret: true }], relations: [], quests: [] });
    await sleep({ store, llm, now });
    const failures = await readFailures(store);
    expect(Object.values(failures)).toEqual([{ attempts: 1, reason: "a new note would be named after a secret value" }]);
    expect((await store.read("_hippo/review.md"))!).not.toContain("U12345678");
  });

  it("counts the nights an episode fails in a row, and tries a stuck one after newer memories", async () => {
    const { store } = await setup();
    for (let night = 1; night <= SET_ASIDE_AFTER; night++) {
      await sleep({ store, llm: new ScriptedLLM(), now });
      expect(Object.values(await readFailures(store)).map((f) => f.attempts)).toEqual([night, night, night]);
    }
    expect(await store.read("_hippo/review.md")).toContain(`failed ${SET_ASIDE_AFTER} nights in a row; tried last`);
    await store.write("inbox/home-finder/2026-09-28T100000-new.md", memory("home-finder", "2026-09-28T10:00:00Z", "fact", "Landlord confirmed the lease."));
    const vault = await Vault.load(store, { now });
    // Oldest first would pick a stuck one; a stuck one waits behind the new one, but is never dropped.
    expect(pickBatch(vault, 1, await readFailures(store))[0]!.path).toContain("new");
    expect(pickBatch(vault, 4, await readFailures(store))).toHaveLength(4);
    expect(pickBatch(vault, 1)[0]!.path).not.toContain("new");
  });

  it("doesn't log the text of secret-bearing episodes", async () => {
    const store = await passportEpisode(true);
    const lines: string[] = [];
    await sleep({ store, llm: new ScriptedLLM(), now, dryRun: true, log: (m) => lines.push(m) });
    expect(lines.join("\n")).toContain("(residency-agent): (secret)");
    expect(lines.join("\n")).not.toContain("U12345678");
  });

  it("drops a summary that repeats a secret, and commits the rest", async () => {
    const store = await passportEpisode(true);
    const llm = new ScriptedLLM()
      .push("mentions", { entities: [{ name: "Passport", type: "item", aliases: [], domains: ["residency"] }] })
      .push("claims", { facts: [{ entity: "passport", field: "number", value: "U12345678", secret: true }], relations: [], quests: [] })
      .respond("summary", () => ({ summary: "Passport U12345678, valid until 2030." }));
    const report = await sleep({ store, llm, now });

    expect(report.failed).toEqual([]);
    expect(report.summaries).toEqual([]);
    expect(report.warnings).toContain("summary for passport failed: the new summary repeats a confidential or secret value; the previous one stays");
    expect(await store.read("items/passport.md")).toContain("secret://passport/number");
    expect(outsideInbox(store)).not.toContain("U12345678");
  });

  it("fails only the episode whose changes break the audit: it stays in the inbox, and the rest of the run commits", async () => {
    const store = await vaultWith({
      "inbox/residency-agent/2026-09-27T100000-passport.md": episode("residency-agent", "2026-09-27T10:00:00Z", "Passport number U12345678 is needed at the agency.", "secret: true\n"),
      "inbox/home-finder/2026-09-27T120000-landlord.md": episode("home-finder", "2026-09-27T12:00:00Z", "New landlord is João Silva."),
    });
    const llm = new ScriptedLLM()
      .push(
        "mentions",
        { entities: [{ name: "Passport", type: "item", aliases: [], domains: ["residency"] }, { name: "Agência de Migração", type: "faction", aliases: [], domains: [] }] },
        { entities: [{ name: "João Silva", type: "character", aliases: [], domains: ["housing"] }] },
      )
      .push(
        "claims",
        // The model puts the number where no redaction looks: the relation's role.
        { facts: [{ entity: "passport", field: "number", value: "U12345678", secret: true }], relations: [{ from: "passport", rel: "requires", to: "migration-agency", role: "U12345678" }] },
        { facts: [{ entity: "joao-silva", field: "role", value: "landlord", secret: false }], relations: [] },
      )
      .respond("summary", () => ({ summary: "A note." }));
    const report = await sleep({ store, llm, now });

    expect(report.failed).toEqual([expect.objectContaining({ path: "inbox/residency-agent/2026-09-27T100000-passport.md", error: expect.stringContaining("contains a secret value") })]);
    expect(report.failed[0]!.error).not.toContain("U12345678");
    expect(report.consolidated.map((c) => c.agent)).toEqual(["home-finder"]);
    expect(await store.list("inbox")).toEqual(["inbox/residency-agent/2026-09-27T100000-passport.md"]);
    expect(await store.read("items/passport.md")).toBeUndefined();
    expect(await store.read("characters/joao-silva.md")).toContain("landlord");
    expect(await store.read("_hippo/review.md")).toContain("`inbox/residency-agent/2026-09-27T100000-passport.md` — contains a secret value (failed 1 night in a row)");
    expect(outsideInbox(store)).not.toContain("U12345678");
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

// ── Generic building blocks: kinds, qualifiers, managed memory, identity ────────

const PEOPLE_CONFIG = `version: ${CURRENT_VAULT_VERSION}
name: lisbon-arc
humans: [{ id: player }]
domains: [residency, housing, university, career]
types:
  character:
    folder: characters
    description: People
    fields:
      employer: { succession: true, domain: career }
      email: { identity_key: true }
      pronouns: { human_only: true }
      birthday: date
  faction: { folder: factions, description: Organizations }
  location: { folder: locations, description: Places }
  item: { folder: items, description: Documents, fields: { number: { secret: true } } }
  goal: { folder: goals, description: Goals, capabilities: [goal] }
  party: { folder: party, description: Agents, capabilities: [actor] }
kinds:
  call:
    behaviour: interaction
    text: forbidden
    counts_as_contact: true
    description: A phone or video call.
    data: { with: { kind: ref }, channel: { kind: enum, values: [phone, video] } }
relations: [handles, located_in, requires, part_of, involves, owns, works_at]
`;

/** An episode of any kind, with extra frontmatter lines. */
const memory = (agent: string, at: string, kind: string, text: string, extra = "") => `---\nagent: ${agent}\nkind: ${kind}\nat: ${at}\n${extra}---\n${text}${text ? "\n" : ""}`;

function people(inbox: Record<string, string>): MemoryStore {
  return fixtureStore({
    "_hippo/config.yaml": PEOPLE_CONFIG,
    "party/job-scout.md": "---\ntype: party\ntitle: Job Scout\nlane: jobs\nauthority: [career]\n---\n",
    "characters/joao-silva.md": `---\ntype: character\ntitle: João Silva\ntags: [housing]\nfacts:\n  employer: { value: Harbor University, status: canon, by: job-scout, at: "2026-01-10T09:00:00Z" }\n---\n`,
    "characters/case-officer.md": "---\ntype: character\ntitle: Case Officer\nfacts:\n  email: officer@lisbon.example\n---\n",
    "characters/desk-clerk.md": "---\ntype: character\ntitle: Desk Clerk\n---\n",
    "locations/alfama-flat.md": "---\ntype: location\ntitle: Alfama flat\n---\n",
    ...Object.fromEntries(Object.entries(inbox).map(([path, raw]) => [`inbox/${path}`, raw])),
  });
}

const fm = async (store: MemoryStore, path: string) => parseDoc((await store.read(path))!).data as any;
const noClaims = { facts: [], relations: [] };
const summaries = (llm: ScriptedLLM) => llm.respond("summary", () => ({ summary: "A note." }));
const joao = { entities: [{ name: "João Silva", type: "character", aliases: [], domains: [] }] };
const section = (review: string, title: string) => review.split(`## ${title}`)[1]!.split("\n## ")[0]!;

describe("sleep with kinds, qualifiers and managed memory", () => {
  it("succeeds a succession field: the old employer is closed into `was`", async () => {
    const store = people({ "job-scout/2026-09-27T100000-job.md": memory("job-scout", "2026-09-27T10:00:00Z", "fact", "João Silva now works at Lisbon Tech.") });
    const llm = summaries(new ScriptedLLM().push("mentions", joao).push("claims", { ...noClaims, facts: [{ entity: "joao-silva", field: "employer", value: "Lisbon Tech", secret: false }] }));
    const report = await sleep({ store, llm, now });

    expect(report.failed).toEqual([]);
    expect(report.consolidated[0]!.facts[0]).toMatchObject({ field: "employer", decision: "succeed" });
    const employer = (await fm(store, "characters/joao-silva.md")).facts.employer;
    expect(employer).toMatchObject({ value: "Lisbon Tech", status: "canon", by: "job-scout" });
    expect(employer.was).toEqual([expect.objectContaining({ value: "Harbor University", why: "succeeded" })]);
  });

  it("keys scoped facts by their scope, the claim's or else the episode's", async () => {
    const store = people({
      "home-finder/2026-09-27T100000-a.md": memory("home-finder", "2026-09-27T10:00:00Z", "fact", "In Portuguese, greet João with 'Olá João'."),
      "home-finder/2026-09-27T110000-b.md": memory("home-finder", "2026-09-27T11:00:00Z", "fact", "In English, greet him with 'Hello'.", "scope: lang:en\n"),
    });
    const llm = summaries(
      new ScriptedLLM()
        .push("mentions", joao, joao)
        .push(
          "claims",
          { ...noClaims, facts: [{ entity: "joao-silva", field: "greeting", value: "Olá João", secret: false, scope: "lang:pt" }] },
          { ...noClaims, facts: [{ entity: "joao-silva", field: "greeting", value: "Hello", secret: false }] },
        ),
    );
    const report = await sleep({ store, llm, now });

    expect(report.consolidated.flatMap((c) => c.facts.map((f) => f.field))).toEqual(["greeting@lang:pt", "greeting@lang:en"]);
    const { facts } = await fm(store, "characters/joao-silva.md");
    expect(facts["greeting@lang:pt"]).toMatchObject({ value: "Olá João" });
    expect(facts["greeting@lang:en"]).toMatchObject({ value: "Hello" });
    expect(facts.greeting).toBeUndefined();
    // The episode's scope is shown to the model.
    expect(llm.calls.find((c) => c.name === "claims" && c.prompt.includes("Hello"))!.prompt).toContain("Scope: lang:en");
  });

  it("turns an agent's value for a human-only field into a proposal, reviewed apart from disputes", async () => {
    const store = people({ "home-finder/2026-09-27T100000-p.md": memory("home-finder", "2026-09-27T10:00:00Z", "fact", "João Silva uses he/him.") });
    const llm = summaries(new ScriptedLLM().push("mentions", joao).push("claims", { ...noClaims, facts: [{ entity: "joao-silva", field: "pronouns", value: "he/him", secret: false }] }));
    const report = await sleep({ store, llm, now });

    expect(report.consolidated[0]).toMatchObject({ proposals: ["joao-silva.pronouns"], facts: [expect.objectContaining({ decision: "propose" })] });
    expect((await fm(store, "characters/joao-silva.md")).facts.pronouns).toBeUndefined();
    expect(await fm(store, "disputes/proposal-joao-silva-pronouns.md")).toMatchObject({ kind: "proposal", state: "pending", status: "open" });
    const review = (await store.read("_hippo/review.md"))!;
    expect(section(review, "💡 Proposals")).toContain("[[proposal-joao-silva-pronouns]]");
    expect(section(review, "⚖ Disputes")).toContain("- (none)");
    expect(report.consolidated[0]!.proposals).toHaveLength(1);
  });

  it("counts a data-only interaction on its contact without asking the model anything", async () => {
    const store = people({
      "home-finder/2026-09-27T100000-call.md": memory("home-finder", "2026-09-27T10:00:00Z", "call", "", 'data:\n  with: "[[joao-silva]]"\n  channel: phone\n'),
      "home-finder/2026-09-27T110000-call.md": memory("home-finder", "2026-09-27T11:00:00Z", "call", "", 'data:\n  with: "[[nobody-known]]"\n  channel: video\n'),
    });
    const llm = new ScriptedLLM();
    const report = await sleep({ store, llm, now });

    expect(report.failed).toEqual([]);
    expect(llm.calls).toEqual([]);
    expect(report.consolidated[0]).toMatchObject({ touched: ["joao-silva"], stats: ["joao-silva"], created: [] });
    expect((await fm(store, "characters/joao-silva.md")).stats).toEqual({ first_met: "2026-09-27", last_contact: "2026-09-27", last: { call: "2026-09-27", "call/phone": "2026-09-27" }, counts: { call: 1, "call/phone": 1 } });
    // A link to no note creates nothing: it's a shape note for the human.
    expect(report.consolidated[1]).toMatchObject({ touched: [], created: [], notes: ["data.with links to no note; left unlinked"] });
    expect(await store.list("characters")).not.toContain("characters/nobody-known.md");
    const chronicle = (await store.read("chronicle/2026/09/2026-09-27.md"))!;
    expect(chronicle).toContain("· call/phone\n> phone with [[joao-silva]]");
    expect(section((await store.read("_hippo/review.md"))!, "📐 Shape notes")).toContain("data.with links to no note");
    expect(await store.list("inbox")).toEqual([]);
  });

  it("suggests domains the model wanted but the config lacks, never from a confidential or secret episode, and never writes the config", async () => {
    const store = people({
      "home-finder/2026-09-27T100000-a.md": memory("home-finder", "2026-09-27T10:00:00Z", "fact", "João Silva walks his dog in Alfama every morning."),
      "home-finder/2026-09-27T110000-b.md": memory("home-finder", "2026-09-27T11:00:00Z", "fact", "João Silva takes the dog to the vet on Fridays, then runs errands."),
      "home-finder/2026-09-27T120000-c.md": memory("home-finder", "2026-09-27T12:00:00Z", "fact", "João Silva has a hospital appointment.", "confidential: true\n"),
      "home-finder/2026-09-27T130000-d.md": memory("home-finder", "2026-09-27T13:00:00Z", "fact", "João Silva's gym card is GYM-0042.", "secret: true\n"),
    });
    const wants = (domains: string[]) => ({ entities: [{ name: "João Silva", type: "character", aliases: [], domains }] });
    const llm = summaries(
      new ScriptedLLM()
        .push("mentions", wants(["Pets", "housing", "Side Project!"]), wants(["pets", "errands", "fitness-2024"]), wants(["health"]), wants(["gym"]))
        .push("claims", noClaims, noClaims, noClaims, noClaims),
    );
    const report = await sleep({ store, llm, now });

    expect(report.failed).toEqual([]);
    expect(report.consolidated.map((c) => c.domains)).toEqual([["pets"], ["pets", "errands"], undefined, undefined]);
    // Tags still come from the config's list only.
    expect((await fm(store, "characters/joao-silva.md")).tags).toEqual(["housing"]);
    const review = (await store.read("_hippo/review.md"))!;
    expect(parseDoc(review).data.suggested_domains).toEqual(["pets", "errands"]);
    expect(review).toContain("Domains the curator wanted that the vault doesn't have (add them on the Agents page or with `hippo domain add`):\n\n- `pets` (2 episodes)\n- `errands` (1 episode)\n");
    expect(review).not.toMatch(/health|gym|side project|fitness/i);
    expect(await store.read("_hippo/config.yaml")).toBe(PEOPLE_CONFIG);
  });

  it("logs a decision on the note it's about", async () => {
    const text = "Rent the Alfama flat rather than the Baixa one: it is closer to campus.";
    const store = people({ "home-finder/2026-09-27T100000-d.md": memory("home-finder", "2026-09-27T10:00:00Z", "decision", text, "about: [alfama-flat]\n") });
    const llm = summaries(new ScriptedLLM().push("mentions", { entities: [] }).push("claims", noClaims));
    const report = await sleep({ store, llm, now });

    const { decisions } = await fm(store, "locations/alfama-flat.md");
    expect(decisions).toEqual([expect.objectContaining({ what: text, by: "home-finder", at: "2026-09-27T10:00:00.000Z" })]);
    expect(report.consolidated[0]!.decisions).toEqual([`alfama-flat: ${decisions[0].id}`]);
    expect(await store.read("locations/alfama-flat.md")).toContain("hippo:begin decisions");
  });

  it("opens a question, and closes it when a later episode answers it", async () => {
    const q = "When does the lease renewal window open?";
    const id = `q-${hash(normalizeName(q))}`;
    const store = people({
      "home-finder/2026-09-27T100000-q.md": memory("home-finder", "2026-09-27T10:00:00Z", "question", q, "about: [joao-silva]\n"),
      "residency-agent/2026-09-27T120000-a.md": memory("residency-agent", "2026-09-27T12:00:00Z", "fact", "João says the renewal window opens on 2026-11-01.", "about: [joao-silva]\n"),
    });
    const llm = summaries(
      new ScriptedLLM()
        .push("mentions", { entities: [] }, { entities: [] })
        .push("claims", noClaims, { ...noClaims, facts: [{ entity: "joao-silva", field: "renewal_window", value: "2026-11-01", secret: false }], answered: [id] }),
    );
    const report = await sleep({ store, llm, now });

    expect(report.failed).toEqual([]);
    expect(report.consolidated.map((c) => c.questions)).toEqual([[`? ${id} on joao-silva`], [`✓ ${id} on joao-silva`]]);
    expect((await fm(store, "characters/joao-silva.md")).questions).toEqual([
      expect.objectContaining({ id, q, status: "answered", by: "home-finder", answered_by: "residency-agent", answered_at: "2026-09-27T12:00:00.000Z" }),
    ]);
    // The second claims step was shown the open question and could only answer its id.
    const second = llm.calls.filter((c) => c.name === "claims")[1]!;
    expect(second.prompt).toContain(`Open questions:\n- ${id} (joao-silva): ${q}`);
    expect(llm.calls.filter((c) => c.name === "claims")[0]!.prompt).not.toContain("Open questions");
  });

  it("turns a commitment into one goal with owner, counterparty and due date", async () => {
    const commitment = { title: "Send the signed lease", owner: "home-finder", counterparty: "joao-silva", due: "2026-10-05", objectives: ["Sign the lease", "Scan it"] };
    const store = people({
      "home-finder/2026-09-27T100000-t.md": memory("home-finder", "2026-09-27T10:00:00Z", "task", "Promised João to send the signed lease by 2026-10-05."),
      "home-finder/2026-09-27T110000-t.md": memory("home-finder", "2026-09-27T11:00:00Z", "task", "Reminder: the signed lease goes to João by 2026-10-05."),
    });
    const llm = summaries(
      new ScriptedLLM()
        .push("mentions", joao, joao)
        .push("claims", { ...noClaims, commitments: [commitment] }, { ...noClaims, commitments: [{ ...commitment, title: "send the signed lease ", objectives: ["Scan it"] }] }),
    );
    const report = await sleep({ store, llm, now });

    expect(report.failed).toEqual([]);
    expect((await store.list("goals")).filter((p) => p.includes("lease"))).toEqual(["goals/send-the-signed-lease.md"]);
    expect(await fm(store, "goals/send-the-signed-lease.md")).toMatchObject({ type: "goal", title: "Send the signed lease", owner: "[[home-finder]]", counterparty: "[[joao-silva]]", due: "2026-10-05", tags: ["housing"] });
    expect(await store.read("goals/send-the-signed-lease.md")).toContain("- [ ] Sign the lease\n- [ ] Scan it");
    expect(report.consolidated[0]).toMatchObject({ created: ["send-the-signed-lease"], goals: [expect.stringMatching(/^send-the-signed-lease: new, /)] });
    // The second report is the same promise: nothing new.
    expect(report.consolidated[1]).toMatchObject({ created: [], goals: [] });
  });

  it("keeps a guideline a rumor until a second agent says it, and reviews it meanwhile", async () => {
    const rule = { entity: "joao-silva", rule: "Message him on WhatsApp rather than calling" };
    const store = people({ "home-finder/2026-09-27T100000-g.md": memory("home-finder", "2026-09-27T10:00:00Z", "observation", "João prefers WhatsApp messages to calls.") });
    await sleep({ store, llm: summaries(new ScriptedLLM().push("mentions", joao).push("claims", { ...noClaims, guidelines: [rule] })), now });

    expect((await fm(store, "characters/joao-silva.md")).guidelines).toEqual([expect.objectContaining({ rule: rule.rule, status: "rumor", by: "home-finder", seen_by: ["home-finder"] })]);
    expect(section((await store.read("_hippo/review.md"))!, "🧭 New guidelines")).toContain(`[[joao-silva]] · ${rule.rule} (home-finder)`);

    await store.write("inbox/residency-agent/2026-09-28T100000-g.md", memory("residency-agent", "2026-09-28T10:00:00Z", "observation", "Better to text João on WhatsApp than call."));
    const report = await sleep({ store, llm: summaries(new ScriptedLLM().push("mentions", joao).push("claims", { ...noClaims, guidelines: [{ ...rule, rule: "message him on WhatsApp rather than calling" }] })), now });

    expect(report.consolidated[0]!.guidelines).toEqual(["joao-silva"]);
    const [g] = (await fm(store, "characters/joao-silva.md")).guidelines;
    expect(g).toMatchObject({ rule: rule.rule, status: "canon" });
    expect(g.seen_by).toBeUndefined();
    expect(section((await store.read("_hippo/review.md"))!, "🧭 New guidelines")).toContain("- (none)");
  });

  it("raises a possible duplicate when a named note's identity key belongs to another note, and learns no names from the name alone", async () => {
    const store = people({ "home-finder/2026-09-27T100000-m.md": memory("home-finder", "2026-09-27T10:00:00Z", "fact", "The Desk Clerk (the clerk) is the landlord's agent.") });
    const llm = summaries(
      new ScriptedLLM()
        .push("mentions", { entities: [{ name: "Desk Clerk", type: "character", aliases: ["the clerk"], domains: [] }] })
        .push("claims", { ...noClaims, facts: [{ entity: "desk-clerk", field: "email", value: "officer@lisbon.example", secret: false }] }),
    );
    const report = await sleep({ store, llm, now });

    expect(report.failed).toEqual([]);
    expect(report.consolidated[0]!.merges).toEqual(["merge-case-officer-desk-clerk"]);
    expect(await fm(store, "disputes/merge-case-officer-desk-clerk.md")).toMatchObject({ kind: "merge", state: "pending", targets: ["[[case-officer]]", "[[desk-clerk]]"] });
    expect((await fm(store, "characters/desk-clerk.md")).aliases).not.toContain("the clerk");
    const review = (await store.read("_hippo/review.md"))!;
    expect(section(review, "🔗 Possible duplicates")).toContain("[[merge-case-officer-desk-clerk]] — [[case-officer]] · [[desk-clerk]] (same email)");
    expect(section(review, "⚖ Disputes")).toContain("- (none)");
  });

  it("files a new name under the note its identity key matches, and keeps the key out of the chronicle", async () => {
    const store = people({ "home-finder/2026-09-27T100000-k.md": memory("home-finder", "2026-09-27T10:00:00Z", "fact", "C. Officer wrote from officer@lisbon.example about the flat.") });
    const llm = summaries(
      new ScriptedLLM()
        .push("mentions", { entities: [{ name: "C. Officer", type: "character", aliases: [], domains: [] }] })
        .push("match", { match: "new" })
        .push("claims", { ...noClaims, facts: [{ entity: "c-officer", field: "email", value: "officer@lisbon.example", secret: false }] }),
    );
    // The audit refuses a confidential value newly in the chronicle: the commit going through is the test.
    const report = await sleep({ store, llm, now });

    expect(report.failed).toEqual([]);
    expect(report.consolidated[0]).toMatchObject({ created: [], touched: ["case-officer"], facts: [expect.objectContaining({ entity: "case-officer", field: "email" })] });
    expect(await store.read("characters/c-officer.md")).toBeUndefined();
    expect((await fm(store, "characters/case-officer.md")).aliases).toContain("C. Officer");
    const chronicle = (await store.read("chronicle/2026/09/2026-09-27.md"))!;
    expect(chronicle).toContain("C. Officer wrote from [redacted] about the flat.");
    expect(llm.calls.find((c) => c.name === "summary")!.prompt).not.toContain("officer@lisbon.example");
  });

  it("lets the curator read a confidential episode, but keeps it out of summaries, the chronicle and search", async () => {
    const text = "Case Officer told me her salary is 4200 EUR and that she worries about the visa.";
    const store = people({ "home-finder/2026-09-27T100000-c.md": memory("home-finder", "2026-09-27T10:00:00Z", "fact", text, "confidential: true\n") });
    const llm = summaries(
      new ScriptedLLM()
        .push("mentions", { entities: [{ name: "Case Officer", type: "character", aliases: [], domains: [] }] })
        .push("claims", { ...noClaims, facts: [{ entity: "case-officer", field: "salary", value: "4200 EUR", secret: false }], guidelines: [{ entity: "case-officer", rule: "Don't bring up money" }] }),
    );
    const report = await sleep({ store, llm, now });

    expect(report.failed).toEqual([]);
    // The curator sees it, marked.
    expect(llm.calls.find((c) => c.name === "mentions")!.prompt).toContain(`Confidential: yes`);
    expect(llm.calls.find((c) => c.name === "claims")!.prompt).toContain(text);
    expect((await fm(store, "characters/case-officer.md")).facts.salary).toMatchObject({ value: "4200 EUR", confidential: true });
    // Words of a confidential episode don't become shared memory.
    expect((await fm(store, "characters/case-officer.md")).guidelines).toBeUndefined();
    expect(report.consolidated[0]!.notes).toEqual(["confidential: guidelines kept out of shared notes"]);

    const summary = llm.calls.find((c) => c.name === "summary")!.prompt;
    expect(summary).not.toContain("4200");
    expect(summary).toContain("- salary: ◐ confidential (rumor)");
    expect(summary).toContain("- (confidential)");
    const chronicle = (await store.read("chronicle/2026/09/2026-09-27.md"))!;
    expect(chronicle).toContain("(confidential)");
    expect(chronicle).not.toContain("4200");
    expect(chronicle).not.toContain("visa");
    expect(JSON.stringify(searchDocs(await Vault.load(store, { now })))).not.toContain("4200");
    expect(JSON.stringify(report)).not.toContain("4200");
  });

  it("asks the claims step in the old `quests` shape and gets goals", async () => {
    const vault = await Vault.load(fixtureStore(), { now });
    const schema = claimsSchema(vault, ["residence-permit"], { goals: ["residence-permit"] });
    const parsed = schema.parse({ facts: [], relations: [], quests: [{ quest: "residence-permit", status: "done", completed: [], added: [] }] });
    expect(parsed).toEqual({ facts: [], relations: [], goals: [{ goal: "residence-permit", status: "done", completed: [], added: [] }], commitments: [], guidelines: [] });
    expect(describeEpisode({ id: "ep-1", agent: "home-finder", created: [], touched: ["residence-permit"], facts: [], relations: [], quests: ["residence-permit: status done"] } as never)).toBe(
      "touched residence-permit · residence-permit: status done",
    );
  });
});

describe("review fixes: one episode never spoils the run, and private words stay private", () => {
  const memory = (agent: string, at: string, kind: string, text: string, extra = "") => `---\nagent: ${agent}\nkind: ${kind}\nat: ${at}\n${extra}---\n${text}\n`;
  const LANDLORD = { "characters/landlord.md": "---\ntype: character\ntitle: The landlord\n---\n\n## Notes\n" };
  const landlord = { entities: [{ name: "The landlord", type: "character", aliases: [], domains: [] }] };
  const none = { facts: [], relations: [] };
  const read = async (store: MemoryStore, path: string) => parseDoc((await store.read(path))!).data as any;

  it("redacts an earlier entry of the run once a later episode makes its value confidential (finding 2)", async () => {
    const store = fixtureStore({
      ...LANDLORD,
      "inbox/job-scout/2026-09-27T100000-a.md": memory("job-scout", "2026-09-27T10:00:00Z", "fact", "The landlord earns 4200 EUR."),
      "inbox/job-scout/2026-09-27T110000-b.md": memory("job-scout", "2026-09-27T11:00:00Z", "fact", "The landlord earns 4200 EUR.", "confidential: true\n"),
    });
    const salary = { ...none, facts: [{ entity: "landlord", field: "salary", value: "4200 EUR", secret: false }] };
    const llm = new ScriptedLLM().push("mentions", landlord, landlord).push("claims", salary, salary).respond("summary", () => ({ summary: "A note." }));
    const report = await sleep({ store, llm, now });

    expect(report.failed).toEqual([]);
    expect(report.consolidated).toHaveLength(2);
    const day = (await store.read("chronicle/2026/09/2026-09-27.md"))!;
    expect(day).not.toContain("4200");
    expect(day).toContain("The landlord earns [redacted].");
    expect(llm.calls.find((c) => c.name === "summary")!.prompt).not.toContain("4200");
  });

  it("drops a summary that repeats a confidential value, not the run (finding 4)", async () => {
    const store = fixtureStore({
      ...LANDLORD,
      "inbox/home-finder/2026-09-27T100000-a.md": memory("home-finder", "2026-09-27T10:00:00Z", "fact", "The landlord's salary is 4200 EUR.", "confidential: true\n"),
    });
    const llm = new ScriptedLLM()
      .push("mentions", landlord)
      .push("claims", { ...none, facts: [{ entity: "landlord", field: "salary", value: "4200 EUR", secret: false }] })
      .respond("summary", () => ({ summary: "The landlord (4200 EUR) rents the flat." }));
    const report = await sleep({ store, llm, now });
    expect(report.failed).toEqual([]);
    expect(report.warnings.some((w) => w.startsWith("summary for landlord failed"))).toBe(true);
    expect(parseDoc((await store.read("characters/landlord.md"))!).body).not.toContain("4200");
  });

  it("never logs a secret-bearing episode's text as a decision or question, and redacts data it logs (finding 5)", async () => {
    const { recipient } = await generateKeyPair();
    for (const kind of ["decision", "question"]) {
      const store = fixtureStore({
        "inbox/residency-agent/2026-09-27T100000-d.md": memory("residency-agent", "2026-09-27T10:00:00Z", kind, "Passport number U12345678 goes on the lease form?", "secret: true\nabout: [migration-agency]\n"),
      });
      await store.write("_hippo/config.yaml", `${(await store.read("_hippo/config.yaml"))!}secrets: { recipient: "${recipient}" }\n`);
      const llm = new ScriptedLLM()
        .push("mentions", { entities: [{ name: "Passport", type: "item", aliases: [], domains: [] }] })
        .push("claims", { ...none, facts: [{ entity: "passport", field: "number", value: "U12345678", secret: true }] })
        .respond("summary", () => ({ summary: "A note." }));
      const report = await sleep({ store, llm, now });
      expect(report.failed).toEqual([]);
      expect(report.consolidated[0]!.decisions).toEqual([]);
      expect(report.consolidated[0]!.questions).toEqual([]);
      expect([...store.files].filter(([p]) => !p.startsWith("inbox/")).map(([, c]) => c).join("\n")).not.toContain("U12345678");
    }
    // Data a decision logs is redacted of values that are confidential.
    const store = fixtureStore({
      "characters/landlord.md": "---\ntype: character\ntitle: The landlord\nfacts:\n  salary: { value: 4200 EUR, status: canon, confidential: true }\n---\n\n## Notes\n",
      "inbox/home-finder/2026-09-27T100000-d.md": memory("home-finder", "2026-09-27T10:00:00Z", "decision", "", 'about: [landlord]\ndata:\n  what: "Offer 4200 EUR rent"\n  why: "matches the 4200 EUR salary"\n'),
    });
    const report = await sleep({ store, llm: new ScriptedLLM().respond("summary", () => ({ summary: "A note." })), now });
    expect(report.failed).toEqual([]);
    expect((await read(store, "characters/landlord.md")).decisions[0]).toMatchObject({ what: "Offer [redacted] rent", why: "matches the [redacted] salary" });
  });

  it("a confidential episode only ticks off objectives the goal already has (finding 6)", async () => {
    const store = fixtureStore({
      "inbox/job-scout/2026-09-27T100000-c.md": memory("job-scout", "2026-09-27T10:00:00Z", "fact", "Residence permit: got health insurance after the clinic visit.", "confidential: true\n"),
    });
    const llm = new ScriptedLLM()
      .push("mentions", { entities: [{ name: "Residence permit 2026", type: "goal", aliases: [], domains: [] }] })
      .push("claims", { ...none, goals: [{ goal: "residence-permit", status: "unchanged", completed: ["Get health insurance", "Pay the clinic bill for surgery"], added: [] }] })
      .respond("summary", () => ({ summary: "A note." }));
    const report = await sleep({ store, llm, now });
    const goal = (await store.read("goals/residence-permit.md"))!;
    expect(goal).toContain("- [x] Get health insurance");
    expect(goal).not.toContain("clinic");
    expect(report.consolidated[0]!.goals).toEqual(["residence-permit: ✓ Get health insurance"]);
    expect(report.consolidated[0]!.notes).toEqual(["confidential: new objectives kept out of shared notes"]);
  });

  it("commitments: one goal per promise, filled not overwritten; status only from the owner or authority (finding 8)", async () => {
    const store = fixtureStore({
      ...LANDLORD,
      "inbox/home-finder/2026-09-27T100000-a.md": memory("home-finder", "2026-09-27T10:00:00Z", "task", "Promised the landlord the signed lease by 2026-10-05."),
      "inbox/home-finder/2026-09-27T110000-b.md": memory("home-finder", "2026-09-27T11:00:00Z", "task", "Reminder: send the signed lease."),
      "inbox/residency-agent/2026-09-27T120000-c.md": memory("residency-agent", "2026-09-27T12:00:00Z", "task", "Residence permit 2026 by 2026-12-31."),
      "inbox/campus-agent/2026-09-27T130000-d.md": memory("campus-agent", "2026-09-27T13:00:00Z", "fact", "The residence permit is done."),
    });
    const goal = { entities: [{ name: "Residence permit 2026", type: "goal", aliases: [], domains: [] }] };
    const llm = new ScriptedLLM()
      // The second episode names nothing: a task kind still gets its claims step.
      .push("mentions", landlord, { entities: [] }, goal, goal)
      .push(
        "claims",
        { ...none, commitments: [{ title: "Send the signed lease", owner: "player", counterparty: "landlord", due: "2026-10-05" }] },
        { ...none, commitments: [{ title: "Send the signed lease", owner: "home-finder", due: "2026-11-01" }] },
        { ...none, commitments: [{ title: "Residence permit 2026", owner: "residency-agent", due: "2026-12-31" }] },
        { ...none, goals: [{ goal: "residence-permit", status: "done", completed: [], added: [] }] },
      )
      .respond("summary", () => ({ summary: "A note." }));
    const report = await sleep({ store, llm, now });

    expect(report.failed).toEqual([]);
    expect(await store.list("goals")).toEqual(["goals/residence-permit.md", "goals/send-the-signed-lease.md"]);
    expect(await read(store, "goals/send-the-signed-lease.md")).toMatchObject({ owner: "[[player]]", counterparty: "[[landlord]]", due: "2026-10-05" });
    expect(await read(store, "goals/residence-permit.md")).toMatchObject({ owner: "[[residency-agent]]", due: "2026-11-30", status: "active" });
    expect(report.consolidated[3]!.notes).toEqual(["residence-permit: status change not applied: campus-agent neither owns it nor has authority over it; set an owner on the goal or grant campus-agent authority"]);
  });

  it("a promise that names no owner belongs to the party member who reported it, and to nobody when an outsider did", async () => {
    const store = fixtureStore({
      "inbox/home-finder/2026-09-27T100000-a.md": memory("home-finder", "2026-09-27T10:00:00Z", "task", "Will book the flat viewing."),
      "inbox/stranger-agent/2026-09-27T110000-b.md": memory("stranger-agent", "2026-09-27T11:00:00Z", "task", "Will water the plants."),
    });
    const llm = new ScriptedLLM()
      .push("mentions", { entities: [] }, { entities: [] })
      .push("claims", { ...none, commitments: [{ title: "Book the flat viewing" }] }, { ...none, commitments: [{ title: "Water the plants" }] })
      .respond("summary", () => ({ summary: "A note." }));
    const report = await sleep({ store, llm, now });
    expect(report.failed).toEqual([]);
    expect(await read(store, "goals/book-the-flat-viewing.md")).toMatchObject({ owner: "[[home-finder]]" });
    expect((await read(store, "goals/water-the-plants.md")).owner).toBeUndefined();
  });

  it("a promise that matches an existing goal with no owner doesn't hand it to the agent that mentioned it", async () => {
    const store = fixtureStore({
      "goals/renew-the-lease.md": "---\ntype: goal\ntitle: Renew the lease\nstatus: active\n---\n\n## Notes\n",
      "inbox/home-finder/2026-09-27T100000-a.md": memory("home-finder", "2026-09-27T10:00:00Z", "task", "Will renew the lease."),
    });
    const llm = new ScriptedLLM()
      .push("mentions", { entities: [{ name: "Renew the lease", type: "goal", aliases: [], domains: [] }] })
      .push("claims", { ...none, commitments: [{ title: "Renew the lease" }] })
      .respond("summary", () => ({ summary: "A note." }));
    await sleep({ store, llm, now });
    expect((await read(store, "goals/renew-the-lease.md")).owner).toBeUndefined();
  });

  it("goes on when the review can't be parsed, and rewrites it", async () => {
    const { store } = await setup();
    await store.write("_hippo/review.md", "---\n<<<<<<< HEAD\nfailures: {\n=======\n---\n");
    const report = await sleep({ store, llm: new ScriptedLLM(), now });
    expect(report.failed).toHaveLength(3);
    expect(Object.values(await readFailures(store)).map((f) => f.attempts)).toEqual([1, 1, 1]);
  });

  it("lists the run's warnings in the review, with the fix for a missing secrets recipient", async () => {
    const { store } = await setup();
    const config = (await store.read("_hippo/config.yaml"))!;
    await store.write("_hippo/config.yaml", config.replace(/secrets:\n {2}recipient: age1\S+\n$/, ""));
    await sleep({ store, llm: script(), now });
    const review = (await store.read("_hippo/review.md"))!;
    expect(review).toContain("What to do next");
    expect(review).toContain("set secrets.recipient");
    expect(review).not.toContain("U12345678");
  });

  it("a new note whose identity key belongs to an unrelated type is kept, with a merge proposal (finding 9)", async () => {
    const config = (await fixtureStore().read("_hippo/config.yaml"))!
      .replace("character: { folder: characters, description: People }", "character: { folder: characters, description: People, fields: { email: { identity_key: true } } }")
      .replace("faction: { folder: factions, description: Organizations }", "faction: { folder: factions, description: Organizations, fields: { email: { identity_key: true } } }");
    const store = fixtureStore({
      "_hippo/config.yaml": config,
      "factions/migration-agency.md": "---\ntype: faction\ntitle: Agência de Migração\nfacts:\n  email: { value: desk@agency.example, status: canon }\n---\n\n## Notes\n",
      "inbox/home-finder/2026-09-27T100000-a.md": memory("home-finder", "2026-09-27T10:00:00Z", "fact", "Met the desk clerk; reach them at desk@agency.example."),
    });
    const llm = new ScriptedLLM()
      .push("mentions", { entities: [{ name: "Desk clerk", type: "character", aliases: [], domains: [] }] })
      .push("claims", { ...none, facts: [{ entity: "desk-clerk", field: "email", value: "desk@agency.example", secret: false }] })
      .respond("summary", () => ({ summary: "A note." }));
    const report = await sleep({ store, llm, now });
    expect(report.failed).toEqual([]);
    expect(report.consolidated[0]!.created).toEqual(["desk-clerk"]);
    expect(report.consolidated[0]!.merges).toEqual(["merge-desk-clerk-migration-agency"]);
    expect(await store.read("characters/desk-clerk.md")).toBeDefined();
  });
});
