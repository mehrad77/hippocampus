import { describe, expect, it } from "vitest";
import { CONFIG, fixtureStore } from "./__fixtures__/vault.ts";
import { auditChanges } from "./audit.ts";
import { parseConfig } from "./config.ts";
import { renderHandbook } from "./handbook.ts";
import { addPartyMember } from "./ops.ts";
import { buildSchema, loadSchema, MAX_EXTENDS_DEPTH, type SchemaNotes } from "./schema-registry.ts";
import { HippoService } from "./service.ts";
import { MemoryStore } from "./store.ts";
import { Vault, VaultError } from "./vault.ts";

const notes = (types: Record<string, { data: Record<string, unknown>; body?: string }> = {}, kinds: Record<string, { data: Record<string, unknown>; body?: string }> = {}): SchemaNotes => ({
  types: new Map(Object.entries(types).map(([k, v]) => [k, { data: v.data, body: v.body ?? "" }])),
  kinds: new Map(Object.entries(kinds).map(([k, v]) => [k, { data: v.data, body: v.body ?? "" }])),
});
const v2 = (extra = "") => parseConfig(`version: 2\n${extra}`);

describe("schema registry", () => {
  it("maps a v1 config's quest, party and campaign types to capabilities, and secret_fields to fields", () => {
    const schema = buildSchema(parseConfig(CONFIG), notes());
    expect(schema.typesWith("goal")).toEqual(["quest"]);
    expect(schema.typesWith("actor")).toEqual(["party"]);
    expect(schema.typesWith("arc")).toEqual(["campaign"]);
    expect(schema.has("character", "actor")).toBe(false);
    expect(schema.defaultTypeFor("actor")).toBe("party");
    expect(schema.isSecretField("item", "number")).toBe(true);
    expect(schema.isSecretField("item", "colour")).toBe(false);
    expect(schema.fieldDef("item", "number")).toMatchObject({ kind: "text", secret: true });
    expect(schema.folders().map((f) => f.folder)).toEqual(["characters", "factions", "locations", "items", "lore", "quests", "campaigns", "party"]);
    expect(schema.typeAt("quests/residence-permit.md")).toBe("quest");
    expect(schema.typeAt("quests/readme.txt")).toBeUndefined();
    expect(schema.warnings).toEqual([]);
  });

  it("does not guess capabilities from names in a v2 config", () => {
    const schema = buildSchema(v2("types:\n  quest: { folder: quests }\n  party: { folder: party, capabilities: [actor] }"), notes());
    expect(schema.typesWith("goal")).toEqual([]);
    expect(schema.typesWith("actor")).toEqual(["party"]);
  });

  it("reads type notes: frontmatter is the definition, the body describes it with examples", () => {
    const schema = buildSchema(
      v2(),
      notes({
        goal: {
          data: { folder: "goals", capabilities: ["goal"], fields: { due: "date", email: { identity_key: true } }, statuses: ["active", "done"] },
          body: "# Goal\n\nSomething to achieve.\n\n## Is\n- Get a residence permit\n- Find a flat\n\n## Is not\n* A one-off errand\n",
        },
      }),
    );
    const goal = schema.type("goal")!;
    expect(goal).toMatchObject({ folder: "goals", description: "Something to achieve.", capabilities: ["goal"], statuses: { active: "active", done: "done" } });
    expect(goal.examples).toEqual({ is: ["Get a residence permit", "Find a flat"], isNot: ["A one-off errand"] });
    expect(goal.fields.due).toMatchObject({ kind: "date" });
    // An identity key is always confidential.
    expect(goal.fields.email).toMatchObject({ identity_key: true, confidential: true });
  });

  it("lets an inline config entry override a note of the same name, key by key", async () => {
    const store = new MemoryStore({
      "_hippo/config.yaml": "version: 1\ntypes:\n  lore:\n    description: How things work at Harbor University\n    fields: { deadline: { kind: date, human_only: true } }\n",
      "_hippo/schema/types/lore.md": "---\nfolder: lore\nfields:\n  source: ref\n  deadline: text\n---\nProcedures.\n",
    });
    const schema = await loadSchema(store, parseConfig(await store.read("_hippo/config.yaml")));
    const lore = schema.type("lore")!;
    expect(lore.folder).toBe("lore");
    expect(lore.description).toBe("How things work at Harbor University");
    expect(lore.fields.source).toMatchObject({ kind: "ref" });
    expect(lore.fields.deadline).toMatchObject({ kind: "date", human_only: true });
  });

  it("merges fields, capabilities, statuses and templates down an extends chain, the child winning", () => {
    const schema = buildSchema(
      v2(),
      notes({
        goal: { data: { folder: "goals", capabilities: ["goal"], fields: { due: "date", amount: "number" }, statuses: ["open", "done"], template: "_hippo/templates/goal.md" } },
        bill: { data: { folder: "bills", extends: "goal", fields: { amount: { kind: "number", secret: true }, payee: "ref" } } },
      }),
    );
    const bill = schema.type("bill")!;
    expect(bill.capabilities).toEqual(["goal"]);
    expect(bill.fields).toMatchObject({ due: { kind: "date" }, amount: { kind: "number", secret: true }, payee: { kind: "ref" } });
    expect(bill.statuses).toEqual({ open: "open", done: "done" });
    expect(bill.template).toBe("_hippo/templates/goal.md");
    expect(schema.isSecretField("bill", "amount")).toBe(true);
    expect(schema.isSecretField("goal", "amount")).toBe(false);
    // New goals get the type that extends nothing, even when an extension sorts first.
    expect(schema.defaultTypeFor("goal")).toBe("goal");
  });

  it("warns about extends cycles, unknown parents and chains deeper than the limit", () => {
    const cyc = buildSchema(v2(), notes({ a: { data: { folder: "a", extends: "b", fields: { x: "text" } } }, b: { data: { folder: "b", extends: "a", fields: { y: "number" } } } }));
    expect(cyc.type("a")!.fields).toMatchObject({ x: { kind: "text" }, y: { kind: "number" } });
    expect(cyc.warnings.some((w) => /extends cycle a → b → a/.test(w))).toBe(true);

    const unknown = buildSchema(v2(), notes({ a: { data: { folder: "a", extends: "nowhere" } } }));
    expect(unknown.warnings).toContain('type "a" extends unknown type "nowhere"');

    const chain: Record<string, { data: Record<string, unknown> }> = {};
    const depth = MAX_EXTENDS_DEPTH + 2;
    for (let i = 0; i < depth; i++) chain[`t${i}`] = { data: { folder: `t${i}`, ...(i ? { extends: `t${i - 1}` } : { capabilities: ["arc"] }), fields: { [`f${i}`]: "text" } } };
    const deep = buildSchema(v2(), notes(chain));
    const last = deep.type(`t${depth - 1}`)!;
    expect(Object.keys(last.fields)).toHaveLength(MAX_EXTENDS_DEPTH + 1);
    expect(last.capabilities).toEqual([]);
    expect(deep.warnings.some((w) => w.includes(`t${depth - 1}`) && w.includes("deeper than"))).toBe(true);
  });

  it("warns about a type without a folder and uses its name", () => {
    const schema = buildSchema(v2(), notes({ errand: { data: {} } }));
    expect(schema.type("errand")!.folder).toBe("errand");
    expect(schema.warnings).toContain('type "errand" has no folder; using "errand/"');
  });

  it("has the core kinds built in, with beat as an alias of observation, and refines them from notes", () => {
    const schema = buildSchema(
      parseConfig(`${CONFIG}kinds:\n  interaction: { counts_as_contact: false }\n`),
      notes({}, { moment: { data: { behaviour: "interaction", text: "gist", gist_max: 140 }, body: "A short moment with someone.\n" }, chat: { data: { alias_of: "interaction" } } }),
    );
    expect(schema.kinds().map((k) => k.name)).toEqual(expect.arrayContaining(["observation", "fact", "decision", "question", "task", "interaction", "beat", "moment", "chat"]));
    expect(schema.kind("beat")).toMatchObject({ name: "beat", unknown: false, def: { behaviour: "observation", aliasOf: "observation", text: "required" } });
    expect(schema.kind(" Fact ")).toMatchObject({ name: "fact", unknown: false, def: { behaviour: "fact" } });
    expect(schema.kind("moment").def).toMatchObject({ behaviour: "interaction", text: "gist", gistMax: 140, description: "A short moment with someone." });
    expect(schema.kind("chat").def).toMatchObject({ behaviour: "interaction", text: "optional", countsAsContact: false });
    expect(schema.kind("interaction").def.countsAsContact).toBe(false);
    expect(schema.kind("gossip")).toMatchObject({ name: "observation", unknown: true });
    expect(schema.kind(undefined)).toMatchObject({ name: "observation", unknown: false });
  });

  it("refuses a vault that defines no types at all", async () => {
    expect(() => buildSchema(v2(), notes())).toThrow(VaultError);
    expect(() => buildSchema(parseConfig("version: 1\ntypes: {}\n"), notes())).toThrow(/defines no entity types/);
    const store = new MemoryStore({ "_hippo/config.yaml": "version: 1\n" });
    await expect(Vault.load(store)).rejects.toThrow(/defines no entity types/);
  });
});

describe("capabilities, not type names", () => {
  // Types declared only as notes, under names the code has never heard of.
  const store = () =>
    new MemoryStore({
      "_hippo/config.yaml": "version: 1\ncampaign: lisbon-arc\nhuman: player\ndomains: [residency]\nrelations: [part_of]\n",
      "_hippo/schema/types/crew.md": "---\nfolder: crew\ncapabilities: [actor]\n---\nThe agents.\n",
      "_hippo/schema/types/errand.md": "---\nfolder: errands\ncapabilities: [goal]\n---\nThings to get done.\n",
      "_hippo/schema/types/place.md": "---\nfolder: places\n---\nWhere things are.\n",
      "crew/residency-agent.md": "---\ntype: crew\ntitle: Residency Agent\nauthority: [residency]\n---\n",
      "errands/residence-permit.md": "---\ntype: errand\ntitle: Residence permit\nstatus: active\nowner: \"[[residency-agent]]\"\n---\n%% hippo:begin objectives %%\n- [ ] Book agency appointment\n%% hippo:end objectives %%\n",
      "places/lisbon.md": "---\ntype: place\ntitle: Lisbon\n---\n",
    });

  it("finds goals and actors by capability", async () => {
    const vault = await Vault.load(store());
    expect(vault.withCapability("goal").map((e) => e.slug)).toEqual(["residence-permit"]);
    expect(vault.actorMember("residency-agent")?.slug).toBe("residency-agent");
    expect(vault.partyMember("residency-agent")?.slug).toBe("residency-agent");
    expect(vault.actor("Residency Agent")?.slug).toBe("residency-agent");
    expect(vault.actorMember("lisbon")).toBeUndefined();
    expect(vault.folderFor("errand")).toBe("errands");
    const handbook = renderHandbook(vault);
    expect(handbook).toContain("| `residency-agent` | Residency Agent |");
    expect(handbook).toContain("[[residence-permit]] — active · owner [[residency-agent]]");
    const member = addPartyMember(vault, { id: "campus-agent", title: "Campus Agent" });
    expect(member.path).toBe("crew/campus-agent.md");
  });

  it("updates a goal through the quest tool, and refuses anything else", async () => {
    const service = new HippoService(store());
    const { changes } = await service.updateQuest("residency-agent", "residence-permit", { complete: ["Book agency appointment"] });
    expect(changes).toEqual(["✓ Book agency appointment"]);
    await expect(service.updateQuest("residency-agent", "lisbon", { status: "done" })).rejects.toThrow(/no goal/);
  });

  it("audits against the schema of the tree being changed", async () => {
    const s = store();
    const errand = (await s.read("errands/residence-permit.md"))!.replace("- [ ]", "- [x]");
    const agent = { kind: "agent" as const, id: "residency-agent", scopes: ["quest"] };
    expect(await auditChanges({ before: s, changes: [{ path: "errands/residence-permit.md", content: errand }], actor: agent })).toEqual([]);
    const crew = (await s.read("crew/residency-agent.md"))!.replace("title: Residency Agent", "title: Residency Bot");
    expect(await auditChanges({ before: s, changes: [{ path: "crew/residency-agent.md", content: crew }], actor: { kind: "curator" } })).toContainEqual({ path: "crew/residency-agent.md", rule: "party note" });
    expect(await auditChanges({ before: s, changes: [{ path: "_hippo/schema/types/place.md", content: "---\nfolder: places\n---\n" }], actor: { kind: "curator" } })).toEqual([
      { path: "_hippo/schema/types/place.md", rule: "protected file" },
    ]);
  });

  it("keeps the fixture vault's behaviour through the legacy names", async () => {
    const vault = await Vault.load(fixtureStore());
    expect(vault.withCapability("goal").map((e) => e.slug)).toEqual(["residence-permit"]);
    expect(vault.withCapability("actor").map((e) => e.slug).sort()).toEqual(["campus-agent", "home-finder", "residency-agent"]);
  });
});
