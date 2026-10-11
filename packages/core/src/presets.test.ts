import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { buildVaultFiles } from "./bootstrap.ts";
import { CONFIG_PATH, parseConfig } from "./config.ts";
import { getHumanGuidelines } from "./entity.ts";
import { parseDoc } from "./markdown.ts";
import { applyPreset, appendSections, loadPreset, mergeSchemaNote, pickPreset, presetCatalog, type Preset } from "./presets.ts";
import { MemoryStore, type Change } from "./store.ts";
import { validateShapes } from "./validate-shapes.ts";
import { Vault } from "./vault.ts";

const ROOT = join(import.meta.dirname, "../../..");

function readDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (statSync(join(dir, rel)).isFile()) out[rel.split(sep).join("/")] = readFileSync(join(dir, rel), "utf8");
  }
  return out;
}

const template = readDir(join(ROOT, "vault-template"));
const PRESETS = Object.fromEntries(readdirSync(join(ROOT, "presets")).map((name) => [name, readDir(join(ROOT, "presets", name))]));
const ALL = ["people", "developer", "business", "student", "household"];

const apply = (store: MemoryStore, changes: Change[]) => {
  for (const c of changes) "remove" in c ? store.files.delete(c.path) : store.files.set(c.path, c.content);
};
const fresh = async (opts: { presets?: string[]; human?: string } = {}) => new MemoryStore(await buildVaultFiles(template, { human: opts.human ?? "player", presets: opts.presets, presetFiles: PRESETS }));
const fm = (store: MemoryStore, path: string) => parseDoc(store.files.get(path)!).data as Record<string, any>;

describe("bundled presets", () => {
  it("are the five, each described", () => {
    expect(presetCatalog(PRESETS).map((p) => p.name)).toEqual(["business", "developer", "household", "people", "student"]);
    for (const p of presetCatalog(PRESETS)) expect(p.description.length).toBeGreaterThan(40);
  });

  it("build one vault together that loads without warnings or shape notes", async () => {
    const store = await fresh({ presets: ALL });
    const vault = await Vault.load(store);
    expect(vault.warnings).toEqual([]);
    expect(validateShapes(vault)).toEqual([]);
    const types = vault.schema.types().map((t) => t.name);
    for (const t of ["archetype", "group", "repo", "service", "client", "deal", "invoice", "course", "assignment", "asset", "chore", "bill"]) expect(types).toContain(t);
    for (const k of ["rollup", "moment", "incident", "commitment", "lecture", "purchase"]) expect(vault.schema.kind(k).unknown).toBe(false);
    expect(vault.config.presets).toEqual(ALL);
    expect(vault.config.relation_inverses).toMatchObject({ depends_on: "used_by" });
    expect(vault.config.domains).toContain("sales");
    // Goal types extend the template's goal: capability, vocabulary, and the parent's fields.
    expect(vault.schema.has("deal", "goal")).toBe(true);
    expect(vault.schema.type("bill")!.statuses).toMatchObject({ paid: "done" });
    expect(vault.schema.kind("commitment").def.goalType).toBe("deal");
    // The archetypes inherit from the stranger, and come rendered.
    const colleague = vault.entities.get("colleague")!;
    expect(colleague.fm.extends).toBe("[[stranger]]");
    expect(store.files.get(colleague.path)).toContain("%% hippo:begin facts %%");
  });

  it("merges the people preset into the person type and gives the human their sections", async () => {
    const store = await fresh({ presets: ["people"], human: "sam" });
    const vault = await Vault.load(store);
    const person = vault.schema.type("character")!;
    expect(person.fields.email).toMatchObject({ identity_key: true, confidential: true });
    expect(person.fields.birthday).toMatchObject({ kind: "date", recurs: "yearly" });
    expect(person.fields.employer).toMatchObject({ succession: true });
    expect(person.fields.sensitivities).toMatchObject({ human_only: true, many: true });
    // The template's own description and examples stay; the preset's joins the description.
    expect(person.description).toMatch(/^People: the humans/);
    expect(person.description).toContain("a person's note is their rapport");
    expect(person.examples.is).toContain("A landlord, a caseworker at the migration agency, a classmate");
    expect(vault.schema.type("archetype")!.fields.autonomy).toMatchObject({ kind: "enum", values: ["draft", "routine", "any"], human_only: true });

    const sam = store.files.get("characters/sam.md")!;
    expect(sam).toMatch(/## Notes[\s\S]*## Guidelines[\s\S]*## Never say[\s\S]*## Boundaries/);
    // The examples are a comment: they're not the human's guidelines until they write their own.
    expect(getHumanGuidelines(vault.entities.get("sam")!)).toBe("");
  });

  it("are pure data: no inbox, chronicle, disputes or secrets", () => {
    for (const [name, files] of Object.entries(PRESETS))
      for (const path of Object.keys(files)) expect(`${name}/${path}`).not.toMatch(/(^|\/)(inbox|chronicle|disputes|secrets)\/|\.age$/);
  });
});

describe("applyPreset", () => {
  it("adds what's missing, skips what the vault has, and changes nothing the second time", async () => {
    const store = await fresh();
    const people = pickPreset(PRESETS, "people");
    const first = await applyPreset(store, people);
    expect(first.added).toEqual(expect.arrayContaining(["_hippo/schema/types/archetype.md", "archetypes/stranger.md", "groups/.gitkeep"]));
    expect(first.merged).toEqual(expect.arrayContaining(["_hippo/schema/types/character.md", "characters/player.md"]));
    expect(first.changes.map((c) => c.path)).toEqual(expect.arrayContaining([CONFIG_PATH, "HANDBOOK.md"]));
    // Nothing is written until the caller applies the batch.
    expect(store.files.has("archetypes/stranger.md")).toBe(false);
    apply(store, first.changes);

    const again = await applyPreset(store, people);
    expect(again.changes).toEqual([]);
    expect(parseConfig(store.files.get(CONFIG_PATH)).presets).toEqual(["people"]);
  });

  it("keeps the human's edits unless forced", async () => {
    const store = await fresh({ presets: ["people"] });
    const mine = "---\ntype: archetype\ntitle: Landlord\ncadence: 1m\n---\nMy own landlord rules.\n";
    store.files.set("archetypes/landlord.md", mine);
    const people = pickPreset(PRESETS, "people");

    const kept = await applyPreset(store, people);
    expect(kept.skipped).toContain("archetypes/landlord.md");
    expect(kept.changes.map((c) => c.path)).not.toContain("archetypes/landlord.md");

    const forced = await applyPreset(store, people, { force: true });
    expect(forced.added).toContain("archetypes/landlord.md");
    apply(store, forced.changes);
    expect(fm(store, "archetypes/landlord.md").cadence).toBe("none");
  });

  it("merges a `merge: true` type note field by field, the vault's definitions winning unless forced", () => {
    const vaults = "---\nfolder: characters\nfields:\n  email: text\n  nickname: { kind: text }\n---\nPeople.\n\n## Is\n- A friend\n";
    const preset = "---\nmerge: true\ncapabilities: [actor]\nfields:\n  email: { kind: ref, identity_key: true }\n  phone: { identity_key: true }\n---\nMore about people.\n";
    const merged = parseDoc(mergeSchemaNote(vaults, preset));
    expect(merged.data).toEqual({
      folder: "characters",
      capabilities: ["actor"],
      fields: { email: { kind: "text", identity_key: true }, nickname: { kind: "text" }, phone: { identity_key: true } },
    });
    expect(merged.body).toBe("People.\n\nMore about people.\n\n## Is\n- A friend\n");
    // Merging again adds nothing.
    expect(mergeSchemaNote(mergeSchemaNote(vaults, preset), preset)).toBe(mergeSchemaNote(vaults, preset));
    expect((parseDoc(mergeSchemaNote(vaults, preset, true)).data.fields as any).email).toEqual({ kind: "ref", identity_key: true });
  });

  it("unions domains and relations into the config, keeping its comments", async () => {
    const store = await fresh();
    const r = await applyPreset(store, pickPreset(PRESETS, "developer"));
    apply(store, r.changes);
    const raw = store.files.get(CONFIG_PATH)!;
    expect(raw).toContain("# Relation vocabulary the curator may use between entities.");
    expect(raw).toMatch(/^relations: \[member_of, .*related_to, \{name: depends_on, inverse: used_by\}\]$/m);
    expect(raw).toMatch(/^presets: \[developer\]$/m);
    const business = await applyPreset(store, pickPreset(PRESETS, "business"));
    apply(store, business.changes);
    expect(parseConfig(store.files.get(CONFIG_PATH))).toMatchObject({ presets: ["developer", "business"], domains: expect.arrayContaining(["finance", "sales"]) });
  });

  it("appends only the human sections the note lacks, to the human it's given", async () => {
    const store = await fresh();
    store.files.set("characters/sam.md", "---\ntype: character\ntitle: Sam\n---\n## Never say\n- \"No worries\"\n");
    const r = await applyPreset(store, pickPreset(PRESETS, "people"), { human: "sam" });
    apply(store, r.changes);
    const sam = store.files.get("characters/sam.md")!;
    expect(sam.match(/## Never say/g)).toHaveLength(1);
    expect(sam).toContain('- "No worries"');
    expect(sam).toMatch(/## Guidelines[\s\S]*## Boundaries/);
    expect(store.files.get("characters/player.md")).not.toContain("## Never say");
    expect(appendSections("## Guidelines\nBe brief.\n", "## guidelines\nx\n").added).toEqual([]);
  });

  it("puts schema notes in the vault's schema folder", async () => {
    const store = await fresh();
    const raw = store.files.get(CONFIG_PATH)!;
    store.files.set(CONFIG_PATH, raw.replace(/^folders:.*$/m, "").concat("folders:\n  schema: meta/schema\n"));
    for (const [path, content] of [...store.files]) {
      if (!path.startsWith("_hippo/schema/")) continue;
      store.files.delete(path);
      store.files.set(path.replace("_hippo/schema/", "meta/schema/"), content);
    }
    const r = await applyPreset(store, pickPreset(PRESETS, "household"));
    expect(r.added).toContain("meta/schema/types/bill.md");
    expect(r.added).not.toContain("_hippo/schema/types/bill.md");
    expect(r.added).toContain("_hippo/templates/bill.md");
  });

  it("refuses a preset whose requirements aren't added, and notes a merge with nothing to merge into", async () => {
    const store = await fresh();
    const needy: Preset = loadPreset("needy", { "preset.yaml": "description: x\nrequires: [people]\n" });
    await expect(applyPreset(store, needy)).rejects.toThrow('preset "needy" needs "people" first');
    const orphan = loadPreset("orphan", { "preset.yaml": "description: x\n", "_hippo/schema/types/robot.md": "---\nmerge: true\nfields: { serial: text }\n---\n" });
    const r = await applyPreset(store, orphan);
    expect(r.skipped).toEqual(["_hippo/schema/types/robot.md"]);
    expect(r.notes[0]).toMatch(/no such type or kind to merge/);
    expect(() => pickPreset(PRESETS, "pirates")).toThrow(/no preset "pirates" \(available: business, developer/);
  });

  it("refuses a vault in an older format", async () => {
    const store = await fresh();
    store.files.set(CONFIG_PATH, store.files.get(CONFIG_PATH)!.replace(/^version: \d+$/m, "version: 1"));
    await expect(applyPreset(store, pickPreset(PRESETS, "people"))).rejects.toThrow(/hippo migrate/);
  });
});
