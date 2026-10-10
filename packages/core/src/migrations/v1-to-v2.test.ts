import { describe, expect, it } from "vitest";
import { V1_CONFIG, V1_FILES, V1_QUEST_BOARD, V1_QUEST_TEMPLATE, V2_TEMPLATE } from "../__fixtures__/v1-vault.ts";
import { auditChanges } from "../audit.ts";
import { parseConfig } from "../config.ts";
import { goalProps } from "../goal.ts";
import { HANDBOOK_PATH } from "../handbook.ts";
import { migrate, type MigrationContext } from "../migrations.ts";
import { bufferedStore, MemoryStore } from "../store.ts";
import { Vault } from "../vault.ts";
import { v1ToV2 } from "./v1-to-v2.ts";

const v1 = (extra: Record<string, string> = {}) => new MemoryStore({ ...V1_FILES, ...extra });
const run = (store: MemoryStore, template: Record<string, string> | null = V2_TEMPLATE) => migrate(store, parseConfig(V1_CONFIG), { template: template ?? undefined });

describe("v1 → v2 migration", () => {
  it("rewrites the vault into the v2 format", async () => {
    const store = v1();
    const r = await run(store);
    expect(r).toMatchObject({ from: 1, to: 2, applied: [expect.stringMatching(/^v1 → v2/)] });
    const changed = Object.fromEntries(r.changes.filter((c) => c.path !== HANDBOOK_PATH).map((c) => [c.path, "remove" in c ? null : c.content]));
    expect(changed).toMatchSnapshot();
    expect(r.notes).toEqual([
      "type `quest` is now `goal` (goals/)",
      "type `campaign` is now `arc` (arcs/)",
      'quests/residence-permit.md: clocks "Savings" kept as objectives (a goal has one progress)',
    ]);
    expect(await store.read(HANDBOOK_PATH)).toMatch(/^# 📜 Handbook — lisbon-arc$/m);
  });

  it("passes the audit as the migration actor", async () => {
    const before = v1();
    const r = await migrate(before, parseConfig(V1_CONFIG), { template: V2_TEMPLATE, dryRun: true });
    expect(await auditChanges({ before, changes: r.changes, actor: { kind: "migration" } })).toEqual([]);
    // The same changes from the curator would be refused.
    expect((await auditChanges({ before, changes: r.changes, actor: { kind: "curator" } })).length).toBeGreaterThan(0);
  });

  it("leaves memory alone: inbox, chronicle, disputes, secrets, party and other notes", async () => {
    const store = v1({ "chronicle/2026/09/2026-09-26.md": "# 2026-09-26\n\n^ep-old\n", "secrets/player/student_number.age": "-----BEGIN AGE ENCRYPTED FILE-----\nx\n" });
    const r = await run(store);
    const touched = r.changes.map((c) => c.path);
    for (const prefix of ["inbox/", "chronicle/", "disputes/", "secrets/", "party/", "characters/", "studies/"]) expect(touched.filter((p) => p.startsWith(prefix))).toEqual([]);
    expect(await store.read("inbox/game-master/2026-09-27T100000-arrival.md")).toBe(V1_FILES["inbox/game-master/2026-09-27T100000-arrival.md"]);
  });

  it("is idempotent: a second run changes nothing", async () => {
    const store = v1();
    await run(store);
    const buffer = bufferedStore(store);
    const notes: string[] = [];
    const ctx: MigrationContext = { template: V2_TEMPLATE, note: (n) => void notes.push(n) };
    await v1ToV2.run(buffer.store, ctx);
    expect(await buffer.changes()).toEqual([]);
    expect(notes).toEqual([]);
    expect(await migrate(store, (await Vault.load(store)).config)).toMatchObject({ applied: [], changes: [] });
  });

  it("loads as a current vault: goals, arcs, actors, the custom type in its own folder", async () => {
    const store = v1();
    await run(store);
    const vault = await Vault.load(store);
    expect(vault.config).toMatchObject({ version: 2, name: "lisbon-arc", humans: [{ id: "player" }] });
    expect(vault.warnings).toEqual([]);
    const goal = vault.entities.get("residence-permit")!;
    expect(goal.path).toBe("goals/residence-permit.md");
    expect(vault.schema.has(goal.fm.type, "goal")).toBe(true);
    expect(goalProps(goal)).toMatchObject({ due: "2026-11-30", progress: { done: 2, total: 6 } });
    expect(goal.fm).not.toHaveProperty("clocks");
    expect(goal.fm).not.toHaveProperty("deadline");
    expect(vault.entities.get("lisbon-arc")).toMatchObject({ path: "arcs/lisbon-arc.md", fm: { type: "arc" } });
    expect(vault.withCapability("actor").map((e) => e.slug).sort()).toEqual(["game-master", "residency-agent"]);
    // The custom type keeps its folder, description and secret field.
    expect(vault.entities.get("portuguese-a2")).toMatchObject({ path: "studies/courses/portuguese-a2.md", fm: { type: "course" } });
    expect(vault.schema.type("course")).toMatchObject({ folder: "studies/courses", description: "Courses at Harbor University." });
    expect(vault.schema.isSecretField("course", "portal_pin")).toBe(true);
    // The human's own wording of a template type stays; the v1 default wording gives way to the note's.
    expect(vault.schema.type("lore")!.description).toBe("How things work at Harbor University.");
    expect(vault.schema.type("character")!.description).toBe("People: the humans and everyone they deal with.");
    expect(vault.schema.isSecretField("item", "iban")).toBe(true);
    // The human's fact and the episode's kind come through.
    expect(vault.entities.get("player")!.fm.facts.student_number!.value).toBe("HU-2026-0042");
    expect(vault.schema.kind("beat")).toMatchObject({ unknown: false, def: { behaviour: "observation", aliasOf: "observation" } });
  });

  it("keeps extra clocks as objectives and drops the clocks region", async () => {
    const store = v1();
    await run(store);
    const raw = (await store.read("goals/residence-permit.md"))!;
    expect(raw).toContain("- [ ] ⏱ Savings 1/4 · due 2026-10-31");
    expect(raw).not.toContain("hippo:begin clocks");
    expect(raw).toContain("Bring two biometric photos to the [[migration-agency]].");
  });

  it("replaces unmodified v1 templates and dashboards, and patches modified ones", async () => {
    const pristine = v1();
    await run(pristine);
    expect(await pristine.read("_hippo/dashboards/goal-board.md")).toBe(V2_TEMPLATE["_hippo/dashboards/goal-board.md"]);
    expect(await pristine.read("_hippo/templates/goal.md")).toBe(V2_TEMPLATE["_hippo/templates/goal.md"]);

    const board = V1_QUEST_BOARD.replace("## Open objectives", "My own note about the board.\n\n## Open objectives");
    const template = V1_QUEST_TEMPLATE.replace("## Notes", "## Notes\nAsk the [[migration-agency]].");
    const edited = v1({ "_hippo/dashboards/quest-board.md": board, "_hippo/templates/quest.md": template });
    await run(edited);
    expect(await edited.read("_hippo/dashboards/quest-board.md")).toBeUndefined();
    const patched = (await edited.read("_hippo/dashboards/goal-board.md"))!;
    expect(patched).toContain("My own note about the board.");
    expect(patched).toContain('FROM "goals"');
    expect(patched).toContain("owner AS Owner, due AS Due");
    expect(patched).not.toMatch(/"quests"|deadline/);
    const goalTemplate = (await edited.read("_hippo/templates/goal.md"))!;
    expect(goalTemplate).toMatch(/^type: goal$/m);
    expect(goalTemplate).toMatch(/^due:$/m);
    expect(goalTemplate).toContain("Ask the [[migration-agency]].");
  });

  it("without a template, generates type notes with the v1 capabilities", async () => {
    const store = v1();
    const r = await run(store, null);
    expect(await store.read("_hippo/schema/types/goal.md")).toBe("---\nfolder: goals\ncapabilities:\n  - goal\n---\nGoals with objectives, owner lane, status, clocks, deadlines.\n");
    expect(await store.read("_hippo/schema/types/party.md")).toMatch(/capabilities:\n {2}- actor/);
    // Unmodified scaffolding is patched instead, under its new name.
    expect(await store.read("_hippo/dashboards/goal-board.md")).toBe(V1_QUEST_BOARD.replaceAll('"quests"', '"goals"').replaceAll("deadline", "due"));
    expect(await auditChanges({ before: v1(), changes: r.changes, actor: { kind: "migration" } })).toEqual([]);
    expect((await Vault.load(store)).withCapability("goal").map((e) => e.path)).toEqual(["goals/residence-permit.md"]);
  });

  it("keeps a custom goal folder, and leaves a note in place when its new path is taken", async () => {
    const config = V1_CONFIG.replace("quest: { folder: quests,", "quest: { folder: projects,");
    const store = v1({ "_hippo/config.yaml": config, "projects/lease.md": "---\ntype: quest\ntitle: Lease\nstatus: active\n---\n" });
    await migrate(store, parseConfig(config), { template: V2_TEMPLATE });
    expect(await store.read("_hippo/schema/types/goal.md")).toMatch(/^folder: projects$/m);
    expect(await store.read("projects/lease.md")).toMatch(/^type: goal$/m);

    const taken = v1({ "goals/residence-permit.md": "---\ntype: lore\n---\n" });
    const r = await run(taken);
    expect(r.notes).toContain("quests/residence-permit.md: not moved, goals/residence-permit.md already exists");
    expect(await taken.read("quests/residence-permit.md")).toMatch(/^type: goal$/m);
  });
});
