import { describe, expect, it } from "vitest";
import { CONFIG, fixtureStore } from "./__fixtures__/vault.ts";
import { createEpisode, parseEpisode, renderEpisode } from "./episode.ts";
import { formatValue } from "./entity.ts";
import { applyFact } from "./ops.ts";
import { channelOf, countsAsContact, dataLine, validateEpisode } from "./kinds.ts";
import { entityText, searchDocs, SearchIndex } from "./search.ts";
import { HippoService } from "./service.ts";
import { Vault, VaultError } from "./vault.ts";
import { entityDetail, parseChronicleDay, viewContext, factDetail } from "./views.ts";

const KINDS_CONFIG = `${CONFIG.replace(
  "character: { folder: characters, description: People }",
  "character: { folder: characters, description: People, fields: { email: { identity_key: true }, nickname: { confidential: true }, stakes: { human_only: true } } }",
)}kinds:
  rollup:
    behaviour: interaction
    text: forbidden
    counts_as_contact: { call: true, "*": false }
    data:
      with: { kind: ref, many: true, required: true }
      channel: { kind: enum, values: [call, email, visit] }
      outcome: text
      minutes: number
  moment: { behaviour: interaction, text: gist, gist_max: 20 }
  note: { behaviour: observation, text: optional, data: { due: date, urgent: bool } }
`;

const now = () => new Date("2026-09-27T12:00:00.000Z");
const LANDLORD = "---\ntype: character\ntitle: The landlord\nfacts:\n  email: { value: landlord@lisbon.example, status: canon }\n  nickname: { value: keyholder, status: canon }\n  city: { value: Lisbon, status: canon }\n---\n";
const kindsStore = (extra: Record<string, string> = {}) => fixtureStore({ "_hippo/config.yaml": KINDS_CONFIG, "characters/landlord.md": LANDLORD, ...extra });
const load = async (extra: Record<string, string> = {}) => Vault.load(kindsStore(extra), { now });

describe("validateEpisode", () => {
  it("enforces each text policy", async () => {
    const { schema } = await load();
    expect(() => validateEpisode(schema, { kind: "fact", text: "  " })).toThrow(/text is required/);
    expect(validateEpisode(schema, { kind: "fact", text: " Enrolment opens 2026-10-01. " })).toEqual({ kind: "fact", text: "Enrolment opens 2026-10-01.", warnings: [] });
    expect(() => validateEpisode(schema, { kind: "rollup", text: "we talked", data: { with: "[[landlord]]" } })).toThrow(VaultError);
    expect(validateEpisode(schema, { kind: "rollup", data: { with: "landlord" } })).toMatchObject({ kind: "rollup", text: "", data: { with: ["[[landlord]]"] } });
    const gist = validateEpisode(schema, { kind: "moment", text: "Coffee at Harbor Cafe, all good" });
    expect(gist.text).toHaveLength(20);
    expect(gist.warnings[0]).toMatch(/gist/);
    expect(() => validateEpisode(schema, { kind: "moment", text: "x".repeat(41) })).toThrow(/at most 20/);
    expect(validateEpisode(schema, { kind: "note", data: { urgent: "yes" } })).toMatchObject({ text: "", data: { urgent: true } });
    expect(() => validateEpisode(schema, { kind: "note" })).toThrow(/needs text or data/);
  });

  it("types data by the kind's fields and keeps undeclared keys with a warning", async () => {
    const { schema } = await load();
    const ok = validateEpisode(schema, { kind: "rollup", data: { with: ["[[landlord]]", "Job Scout"], channel: "CALL", minutes: "15", mood: "good" } });
    expect(ok.data).toEqual({ with: ["[[landlord]]", "[[Job Scout]]"], channel: "call", minutes: 15, mood: "good" });
    expect(ok.warnings).toEqual(['data.mood isn\'t a field of kind "rollup"; kept as given']);
    expect(() => validateEpisode(schema, { kind: "rollup", data: { channel: "call" } })).toThrow(/needs data.with/);
    expect(() => validateEpisode(schema, { kind: "rollup", data: { with: "landlord", channel: "fax" } })).toThrow(/one of call, email, visit/);
    expect(() => validateEpisode(schema, { kind: "rollup", data: { with: "landlord", minutes: "a while" } })).toThrow(/must be a number/);
    expect(() => validateEpisode(schema, { kind: "note", data: { due: "next week" } })).toThrow(/ISO date/);
    expect(() => validateEpisode(schema, { kind: "note", data: { due: ["2026-10-01"] } })).toThrow(/one value/);
  });

  it("files an unknown kind as an observation, with a warning", async () => {
    const { schema } = await load();
    const r = validateEpisode(schema, { kind: "Gossip", text: "The agency is hiring." });
    expect(r.kind).toBe("observation");
    expect(r.warnings[0]).toMatch(/unknown kind "Gossip"; filed as an observation/);
    expect(validateEpisode(schema, { kind: "BEAT", text: "The party reached Lisbon." }).kind).toBe("beat");
  });

  it("counts contact per channel and draws a data line", async () => {
    const { schema } = await load();
    const rollup = schema.kind("rollup").def;
    expect(countsAsContact(rollup, "call")).toBe(true);
    expect(countsAsContact(rollup, "email")).toBe(false);
    expect(countsAsContact(schema.kind("interaction").def, undefined)).toBe(true);
    expect(channelOf({ channel: "Video Call" })).toBe("video-call");
    expect(dataLine(rollup, { with: ["[[landlord]]"], channel: "call", outcome: "out", minutes: 15 })).toBe("call with [[landlord]] · out · 15");
    expect(dataLine(rollup, { with: ["[[landlord]]", "[[job-scout]]"] })).toBe("rollup with [[landlord]], [[job-scout]]");
  });
});

describe("episodes carry kind, data, scope and confidentiality", () => {
  it("round-trips through the inbox file", () => {
    const ep = createEpisode("inbox", { agent: "home-finder", kind: "rollup", data: { with: ["[[landlord]]"], channel: "call" }, confidential: true, scope: "lang:pt" }, now());
    const raw = renderEpisode(ep);
    expect(raw).toContain("confidential: true");
    expect(raw).toContain("scope: lang:pt");
    const back = parseEpisode(ep.path, raw, "inbox", now().toISOString());
    expect(back).toMatchObject({ kind: "rollup", text: "", confidential: true, scope: "lang:pt", data: { with: ["[[landlord]]"], channel: "call" } });
    expect(parseEpisode("inbox/x/a.md", "---\nkind: gossip\n---\nhi\n", "inbox", now().toISOString()).kind).toBe("gossip");
    expect(parseEpisode("inbox/x/a.md", "---\nkind:\n---\nhi\n", "inbox", now().toISOString()).kind).toBe("observation");
    expect(parseEpisode("inbox/x/a.md", "---\nconfidential: \"yes\"\n---\nhi\n", "inbox", now().toISOString()).confidential).toBe(true);
  });

  it("service.remember applies the kind's text policy and returns its warnings", async () => {
    const store = kindsStore();
    const svc = new HippoService(store, { now });
    await expect(svc.remember("home-finder", { kind: "fact" })).rejects.toThrow(/text is required/);
    await expect(svc.remember("home-finder", { kind: "rollup", text: "long chat", data: { with: "landlord" } })).rejects.toThrow(/carries no text/);
    const r = await svc.remember("home-finder", { kind: "rollup", data: { with: "landlord", channel: "call" } });
    expect(r.kind).toBe("rollup");
    const raw = (await store.read(r.path))!;
    expect(raw).toContain("kind: rollup");
    expect(raw).toMatch(/data:\n\s+with:\n\s+- "\[\[landlord\]\]"\n\s+channel: call/);
    const unknown = await svc.remember("home-finder", { kind: "gossip", text: "The flat in Alfama is gone." });
    expect(unknown).toMatchObject({ kind: "observation", warnings: [expect.stringMatching(/unknown kind/)] });
  });
});

describe("chronicle", () => {
  it("shows a placeholder for confidential episodes, the gist for gist kinds, and a data line for text-less ones", async () => {
    const v = await load();
    const at = "2026-09-27T09:15:00.000Z";
    const mk = (id: string, extra: object) => ({ ...createEpisode("inbox", { agent: "home-finder", at, text: "", ...extra }, now()), id });
    await v.appendChronicle(mk("ep-a", { kind: "fact", text: "The landlord's new email is secret-ish.", confidential: true }), ["landlord"]);
    await v.appendChronicle(mk("ep-b", { kind: "moment", text: "Coffee at Harbor Cafe, all good and long" }), ["landlord"]);
    await v.appendChronicle(mk("ep-c", { kind: "rollup", data: { with: ["[[landlord]]"], channel: "call", outcome: "went well" } }), ["landlord"]);
    const day = v.changes().find((c) => c.path === "chronicle/2026/09/2026-09-27.md");
    const content = day && "content" in day ? day.content : "";
    expect(content).toContain("> [!episode] 09:15 · [[home-finder]] · fact\n> (confidential)\n");
    expect(content).not.toContain("secret-ish");
    expect(content).toContain("· moment\n> Coffee at Harbor Ca…\n");
    expect(content).toContain("· rollup/call\n> call with [[landlord]] · went well\n");
    const entries = parseChronicleDay("2026-09-27", content);
    expect(entries.map((e) => [e.id, e.kind])).toEqual([
      ["ep-a", "fact"],
      ["ep-b", "moment"],
      ["ep-c", "rollup/call"],
    ]);
    expect(entries[2]!.text).toBe("call with [[landlord]] · went well");
  });
});

describe("confidentiality in search and views", () => {
  it("keeps confidential facts, identity keys and confidential episodes out of search", async () => {
    const v = await load();
    const landlord = v.resolve("landlord")!;
    await applyFact(v, landlord, "phone", "+351 900 000 004", { by: "player", at: now().toISOString(), src: [] }, { confidential: true });
    const text = entityText(landlord, v.schema);
    expect(text).toContain("Lisbon");
    expect(text).not.toContain("landlord@lisbon.example");
    expect(text).not.toContain("keyholder");
    expect(text).not.toContain("900 000 004");

    v.addEpisode(createEpisode("inbox", { agent: "home-finder", kind: "fact", text: "The landlord prefers the Alfama flat.", confidential: true }, now()));
    v.addEpisode(createEpisode("inbox", { agent: "home-finder", kind: "moment", text: "Viewed the Belém flat with the landlord and the landlord" }, now()));
    const episodes = searchDocs(v).filter((d) => d.kind === "episode");
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.text).toBe("Viewed the Belém fl…");
    const index = new SearchIndex(v);
    expect(await index.search("Alfama", { kind: "episode" })).toEqual([]);
    expect(await index.search("keyholder", { kind: "entity" })).toEqual([]);
  });

  it("masks confidential values for humans and agents", async () => {
    const v = await load();
    const landlord = v.resolve("landlord")!;
    const ctx = viewContext(v);
    expect(factDetail(ctx, landlord, "nickname", landlord.fm.facts.nickname!)).toMatchObject({ value: null, secret: false, confidential: true });
    expect(factDetail(ctx, landlord, "email", landlord.fm.facts.email!)).toMatchObject({ value: null, confidential: true });
    expect(factDetail(ctx, landlord, "city", landlord.fm.facts.city!)).toMatchObject({ value: "Lisbon", secret: false });
    expect((await entityDetail(v, landlord)).facts.find((f) => f.field === "email")?.value).toBeNull();
    expect(formatValue("x", { confidential: true })).toBe("◐ confidential");

    const got = await new HippoService(kindsStore(), { now }).get("landlord");
    expect(got.facts.find((f) => f.field === "email")?.value).toBe("◐ confidential");
    expect(got.facts.find((f) => f.field === "city")?.value).toBe("Lisbon");
  });

  it("marks facts of a confidential field confidential, and masks them in the note's table", async () => {
    const v = await load();
    const landlord = v.resolve("landlord")!;
    await applyFact(v, landlord, "nickname", "Mr Keys", { by: "player", at: now().toISOString(), src: ["ep-1"] });
    expect(landlord.fm.facts.nickname).toMatchObject({ value: "Mr Keys", confidential: true });
    const note = v.changes().find((c) => c.path === "characters/landlord.md");
    expect(note && "content" in note ? note.content : "").toContain("| nickname | ◐ confidential |");
  });
});
