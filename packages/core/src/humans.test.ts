import { describe, expect, it } from "vitest";
import { CONFIG, fixtureStore } from "./__fixtures__/vault.ts";
import { auditChanges } from "./audit.ts";
import { canonicalRelation, parseConfig } from "./config.ts";
import { addRelation, applyFact, applyRuling, assertAgentId } from "./ops.ts";
import { renderEntity } from "./entity.ts";
import { parseDoc } from "./markdown.ts";
import { generateKeyPair } from "./secrets.ts";
import { HippoService } from "./service.ts";
import { Vault, VaultError } from "./vault.ts";

const now = () => new Date("2026-09-27T12:00:00.000Z");
const HUMANS = "humans:\n  - { id: player, domains: [housing] }\n  - { id: game-master, domains: [residency], github: GM-Login, gitlab: gm.lab }\n";
const twoHumans = (extra: Record<string, string> = {}) => fixtureStore({ "_hippo/config.yaml": CONFIG.replace("humans: [{ id: player }]\n", HUMANS), ...extra });

describe("config", () => {
  it("reads v1 `human` and `campaign` as `humans` and `name`, keeping the old names as aliases", () => {
    const c = parseConfig("version: 1\ncampaign: lisbon-arc\nhuman: player\n");
    expect(c).toMatchObject({ name: "lisbon-arc", campaign: "lisbon-arc", humans: [{ id: "player", domains: [] }], human: "player" });
    expect(parseConfig("version: 1\n")).toMatchObject({ name: "campaign", humans: [{ id: "human" }], human: "human" });
  });

  it("reads `humans` and `name`, which win over the v1 keys", () => {
    const c = parseConfig(`version: 1\nname: Harbor term\ncampaign: old\nhuman: someone-else\n${HUMANS}`);
    expect(c.name).toBe("Harbor term");
    expect(c.humans.map((h) => h.id)).toEqual(["player", "game-master"]);
    expect(c.humans[1]).toEqual({ id: "game-master", domains: ["residency"], github: "GM-Login", gitlab: "gm.lab" });
    expect(c.human).toBe("player");
    expect(parseConfig("humans: [player, game-master]\n").humans).toEqual([
      { id: "player", domains: [] },
      { id: "game-master", domains: [] },
    ]);
  });

  it("declares relation inverses, and stores an inverse as its forward relation flipped", () => {
    const c = parseConfig("relations: [owns, { name: depends_on, inverse: used_by }, { name: knows }]\n");
    expect(c.relations).toEqual(["owns", "depends_on", "knows"]);
    expect(c.relation_inverses).toEqual({ depends_on: "used_by" });
    expect(canonicalRelation(c, "used_by")).toEqual({ rel: "depends_on", flip: true });
    expect(canonicalRelation(c, "depends_on")).toEqual({ rel: "depends_on", flip: false });
    expect(canonicalRelation(c, "related_to")).toEqual({ rel: "related_to", flip: false });
  });
});

describe("humans", () => {
  it("knows every human, the primary one, and who a GitHub login is", async () => {
    const v = await Vault.load(twoHumans(), { now });
    expect(v.isHuman("game-master")).toBe(true);
    expect(v.isHuman("Player")).toBe(true);
    expect(v.isHuman(undefined)).toBe(true);
    expect(v.isHuman("residency-agent")).toBe(false);
    expect(v.human()?.id).toBe("player");
    expect(v.human("human")?.id).toBe("player");
    expect(v.human("Game-Master")?.id).toBe("game-master");
    expect(v.human("job-scout")).toBeUndefined();
    expect(v.humanFor("gm-login").id).toBe("game-master");
    expect(v.humanFor("someone").id).toBe("player");
    expect(v.humanFor(undefined).id).toBe("player");
    // A GitLab username matches `gitlab:` only; GitHub logins and GitLab usernames are separate namespaces.
    expect(v.humanFor("GM.Lab", "gitlab").id).toBe("game-master");
    expect(v.humanFor("gm-login", "gitlab").id).toBe("player");
    expect(v.humanFor("gm.lab").id).toBe("player");
  });

  it("refuses every human as an agent id", async () => {
    const v = await Vault.load(twoHumans(), { now });
    expect(() => assertAgentId(v, "game-master")).toThrow(/one of the humans/);
    expect(() => assertAgentId(v, "player")).toThrow(VaultError);
    expect(assertAgentId(v, "job-scout")).toBe("job-scout");
  });

  it("acts as the primary human or a named one, and refuses anyone else", async () => {
    const store = twoHumans();
    const svc = new HippoService(store, { now });
    expect((await svc.remember("", { text: "I prefer morning appointments." }, { asHuman: true })).path).toMatch(/^inbox\/player\//);
    expect((await svc.remember("", { text: "The permit review is mine." }, { asHuman: "game-master" })).path).toMatch(/^inbox\/game-master\//);
    await expect(svc.remember("", { text: "x" }, { asHuman: "job-scout" })).rejects.toThrow(/not one of this vault's humans/);
    await expect(svc.remember("game-master", { text: "x" })).rejects.toThrow(VaultError);
  });

  it("audits a second human's facts as human-held and refuses them as an agent", async () => {
    const store = twoHumans({ "locations/alfama-flat.md": "---\ntype: location\ntitle: Alfama flat\nfacts:\n  rent: { value: 1200 EUR, by: game-master }\n---\n" });
    const changed = "---\ntype: location\ntitle: Alfama flat\nfacts:\n  rent: { value: 1300 EUR, by: home-finder }\n---\n";
    expect(await auditChanges({ before: store, changes: [{ path: "locations/alfama-flat.md", content: changed }], actor: { kind: "curator" } })).toEqual([
      { path: "locations/alfama-flat.md", rule: "human fact changed: rent" },
    ]);
    const ep = "inbox/game-master/2026-09-27T100000-x.md";
    expect(await auditChanges({ before: store, changes: [{ path: ep, content: "---\nagent: game-master\n---\nx\n" }], actor: { kind: "agent", id: "game-master" } })).toEqual([
      { path: ep, rule: "not an agent id" },
    ]);
  });
});

describe("qualifiers", () => {
  it("renders Scope and Valid columns only when a fact uses them", async () => {
    const v = await Vault.load(fixtureStore(), { now });
    const agency = v.resolve("migration-agency")!;
    await applyFact(v, agency, "phone", "+351 900 000 001", { by: "residency-agent", at: "2026-09-10T00:00:00Z", src: ["ep-a"] });
    expect(renderEntity(agency)).toContain("| Fact | Value | Status | By | Since |\n| --- | --- | --- | --- | --- |\n| phone |");
    await applyFact(v, agency, "greeting", "Bom dia", { by: "residency-agent", at: "2026-09-10T00:00:00Z", src: ["ep-b"] }, { scope: "lang:pt", validFrom: "2026-01-01" });
    const out = renderEntity(agency);
    expect(out).toContain("| Fact | Scope | Value | Status | By | Since | Valid |");
    expect(out).toContain("| phone |  | +351 900 000 001 |");
    expect(out).toContain("| greeting | lang:pt | Bom dia | ✓ canon | [[residency-agent]] | 2026-09-10 | since 2026-01-01 |");
    const fm = parseDoc(out).data as { facts: Record<string, unknown> };
    expect(fm.facts["greeting@lang:pt"]).toEqual({ value: "Bom dia", status: "canon", by: "residency-agent", at: "2026-09-10T00:00:00Z", src: ["ep-b"], valid_from: "2026-01-01" });
  });

  it("names a scoped dispute after its scope, and a ruling marks the prior value `ruled`", async () => {
    const v = await Vault.load(fixtureStore(), { now });
    const agency = v.resolve("migration-agency")!;
    await applyFact(v, agency, "greeting", "Olá", { by: "campus-agent", at: "2026-09-10T00:00:00Z", src: ["ep-a"] }, { scope: "lang:pt" });
    await applyFact(v, agency, "greeting", "Oi", { by: "home-finder", at: "2026-09-11T00:00:00Z", src: ["ep-b"] }, { scope: "lang:pt" });
    const d = v.disputeFor("migration-agency", "greeting@lang:pt")!;
    expect(d.slug).toMatch(/^dispute-migration-agency-greeting-lang-pt-[0-9a-z]{6}$/);
    expect(d.fm.field).toBe("greeting@lang:pt");
    expect(applyRuling(v, d, "Olá")).toBe("migration-agency.greeting@lang:pt = Olá");
    expect(agency.fm.facts["greeting@lang:pt"]).toMatchObject({ value: "Olá", status: "canon", by: "player" });
    expect(agency.fm.facts["greeting@lang:pt"]?.was?.at(-1)).toMatchObject({ value: "Olá", by: "campus-agent", why: "ruled" });
  });

  it("stores a scoped secret under a portable file name", async () => {
    const { recipient } = await generateKeyPair();
    const store = fixtureStore({ "items/passport.md": "---\ntype: item\ntitle: Passport\ntags: [residency]\n---\n" });
    await store.write("_hippo/config.yaml", `${CONFIG}secrets:\n  recipient: ${recipient}\n`);
    const v = await Vault.load(store, { now });
    const r = await applyFact(v, v.resolve("passport")!, "number", "U12345678", { by: "residency-agent", at: "2026-09-10T00:00:00Z", src: ["ep-a"] }, { scope: "country:pt" });
    expect(r).toMatchObject({ field: "number@country:pt", secret: true });
    await v.flush();
    expect(v.resolve("passport")!.fm.facts["number@country:pt"]?.value).toBe("secret://passport/number@country~pt");
    expect(await store.read("secrets/passport/number@country~pt.age")).toMatch(/^-----BEGIN AGE ENCRYPTED FILE-----/);
  });
});

describe("relations", () => {
  const withInverse = () =>
    fixtureStore({ "_hippo/config.yaml": CONFIG.replace("relations: [handles,", "relations: [{ name: requires, inverse: required_by }, handles,").replace(", requires,", ",") });

  it("is the same relation only when rel, target, scope and role all match", async () => {
    const v = await Vault.load(fixtureStore(), { now });
    const [quest, agency] = [v.resolve("residence-permit")!, v.resolve("migration-agency")!];
    const prov = { by: "residency-agent", at: "2026-09-10T00:00:00Z", src: ["ep-a"] };
    expect(addRelation(v, quest, "involves", agency, prov)).toBe(true);
    expect(addRelation(v, quest, "involves", agency, prov)).toBe(false);
    expect(addRelation(v, quest, "involves", agency, prov, { role: "issuer" })).toBe(true);
    expect(addRelation(v, quest, "involves", agency, prov, { role: "issuer", scope: "Year:2026", validFrom: "2026-01-01" })).toBe(true);
    expect(addRelation(v, quest, "involves", agency, prov, { role: "issuer", scope: "year:2026" })).toBe(false);
    expect(quest.fm.relations.at(-1)).toEqual({ rel: "involves", target: "[[migration-agency]]", role: "issuer", scope: "year:2026", valid_from: "2026-01-01", by: "residency-agent", src: ["ep-a"] });
  });

  it("stores a declared inverse as its forward relation, flipped", async () => {
    const v = await Vault.load(withInverse(), { now });
    const [quest, agency] = [v.resolve("residence-permit")!, v.resolve("migration-agency")!];
    const prov = { by: "residency-agent", at: "2026-09-10T00:00:00Z", src: ["ep-a"] };
    expect(addRelation(v, agency, "required by", quest, prov)).toBe(true);
    expect(agency.fm.relations).toEqual([]);
    expect(quest.fm.relations).toMatchObject([{ rel: "requires", target: "[[migration-agency]]" }]);
    expect(addRelation(v, quest, "requires", agency, prov)).toBe(false);
  });
});

describe("retract", () => {
  it("lets a human retract a fact, which the next report starts over", async () => {
    const store = fixtureStore();
    const v = await Vault.load(store, { now });
    await applyFact(v, v.resolve("migration-agency")!, "phone", "+351 900 000 001", { by: "residency-agent", at: "2026-09-10T00:00:00Z", src: ["ep-a"] });
    await v.flush();
    const svc = new HippoService(store, { now });
    await expect(svc.retract("migration-agency", "phone", { as: "residency-agent" })).rejects.toThrow(/not one of this vault's humans/);
    expect(await svc.retract("migration-agency", "phone")).toEqual({ entity: "migration-agency", field: "phone" });
    await expect(svc.retract("migration-agency", "phone")).rejects.toThrow(/already retracted/);
    await expect(svc.retract("migration-agency", "fax")).rejects.toThrow(/no fact "fax"/);

    const v2 = await Vault.load(store, { now });
    const agency = v2.resolve("migration-agency")!;
    expect(agency.fm.facts.phone?.status).toBe("retconned");
    const r = await applyFact(v2, agency, "phone", "+351 900 000 002", { by: "campus-agent", at: "2026-09-28T00:00:00Z", src: ["ep-b"] });
    expect(r.decision).toBe("create");
    expect(agency.fm.facts.phone).toMatchObject({ value: "+351 900 000 002", status: "rumor", was: [{ value: "+351 900 000 001" }] });
  });
});
