import { isMap, isScalar, parseDocument } from "yaml";
import { CONFIG_PATH, parseConfig, renderConfig, setHumans } from "../config.ts";
import { basename, parseEntity, renderEntity } from "../entity.ts";
import { getObjectives, legacyClocks, setObjectives } from "../goal.ts";
import { parseDoc, removeRegion, renderDoc } from "../markdown.ts";
import type { Migration, MigrationContext } from "../migrations.ts";
import { DEFAULT_SCHEMA_FOLDER, schemaFolder } from "../schema-registry.ts";
import type { VaultStore } from "../store.ts";

// v1 → v2: generic building blocks. Types move from the config into schema notes, the v1 special
// types get neutral names (quest → goal, campaign → arc; party keeps its name and becomes an actor),
// goals trade `deadline` and `clocks` for `due` and `progress`, and the config says `name`/`humans`.
// Every step is idempotent: on a migrated vault it changes nothing. This module is frozen with the v1
// format: it is the one place, with schema-registry.ts's legacy map, that knows the v1 type names.

/** The v1 types that get a new name, their capability, and their v1 default folder → the v2 one. */
const RENAMED: Record<string, { name: string; capability: string; from: string; to: string }> = {
  quest: { name: "goal", capability: "goal", from: "quests", to: "goals" },
  campaign: { name: "arc", capability: "arc", from: "campaigns", to: "arcs" },
};
/** v1 types that keep their name but now declare a capability. */
const CAPABLE: Record<string, string> = { party: "actor" };

/** The v1 template's type descriptions. A config still saying these takes the v2 note's wording. */
const V1_DESCRIPTIONS: Record<string, string> = {
  character: "People and NPCs, including the player character.",
  faction: "Organizations, institutions, companies, groups.",
  location: "Places: cities, offices, apartments, campuses.",
  item: "Documents, cards, contracts, accounts, physical things.",
  lore: "Procedures, rules, and topic knowledge (how things work).",
  quest: "Goals with objectives, owner lane, status, clocks, deadlines.",
  campaign: "Long arcs that group quests.",
  party: "The agents themselves: lane, authority domains, host.",
};

const V1_QUEST_TEMPLATE = `---
type: quest
title: "{{title}}"
aliases: []
tags: []
status: active
owner: ""
deadline:
---

%% hippo:begin objectives %%
- [ ] First objective
%% hippo:end objectives %%

## Notes
`;

const V1_CAMPAIGN_TEMPLATE = `---
type: campaign
title: "{{title}}"
aliases: []
tags: []
---

## Notes
`;

const V1_QUEST_BOARD = `# 🗺 Quest board

> Requires the Dataview community plugin.

## Active quests

\`\`\`dataview
TABLE WITHOUT ID file.link AS Quest, status AS Status, owner AS Owner, deadline AS Due
FROM "quests"
WHERE status != "done" AND status != "failed"
SORT deadline ASC
\`\`\`

## Open objectives

\`\`\`dataview
TASK
FROM "quests"
WHERE !completed
GROUP BY file.link
\`\`\`

## Recently completed

\`\`\`dataview
TABLE WITHOUT ID file.link AS Quest, updated AS Updated
FROM "quests"
WHERE status = "done"
SORT updated DESC
LIMIT 10
\`\`\`
`;

const V1_ACTIVITY = `# 📡 Activity

## Waiting in the inbox

\`\`\`dataview
TABLE WITHOUT ID file.link AS Episode, agent AS Agent, kind AS Kind, at AS At
FROM "inbox"
SORT at DESC
\`\`\`

## Recently changed canon

\`\`\`dataview
TABLE WITHOUT ID file.link AS Note, type AS Type, updated_by AS By, updated AS Updated
FROM "characters" OR "factions" OR "locations" OR "items" OR "lore" OR "quests" OR "campaigns"
WHERE updated
SORT updated DESC
LIMIT 30
\`\`\`

## Party

\`\`\`dataview
TABLE WITHOUT ID file.link AS Agent, lane AS Lane, authority AS Authority, host AS Host
FROM "party"
\`\`\`
`;

/** Scaffolding the v1 template shipped, by path: its exact text and its v2 path. */
const V1_SCAFFOLD: Record<string, { text: string; to: string }> = {
  "_hippo/templates/quest.md": { text: V1_QUEST_TEMPLATE, to: "_hippo/templates/goal.md" },
  "_hippo/templates/campaign.md": { text: V1_CAMPAIGN_TEMPLATE, to: "_hippo/templates/arc.md" },
  "_hippo/dashboards/quest-board.md": { text: V1_QUEST_BOARD, to: "_hippo/dashboards/goal-board.md" },
  "_hippo/dashboards/activity.md": { text: V1_ACTIVITY, to: "_hippo/dashboards/activity.md" },
};
/** v2 names of scaffolding files named after a v1 type. */
const SCAFFOLD_RENAMES: Record<string, string> = { "quest.md": "goal.md", "campaign.md": "arc.md", "quest-board.md": "goal-board.md" };
const SCAFFOLD_DIRS = ["_hippo/templates", "_hippo/dashboards"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const asList = (v: unknown): string[] => (v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
const under = (path: string, folder: string) => path.startsWith(`${folder}/`);

/** JSON with object keys sorted, so equal values compare equal whatever their key order. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (isObj(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
}

/** A v1 type as v2 knows it: its new name and folder, and the folder its notes lived in. */
interface TypeMove {
  name: string;
  /** The v1 folder (as configured). */
  from: string;
  /** The v2 folder: the new default when the v1 one was the old default, else unchanged. */
  to: string;
}

// ── 1. Config ───────────────────────────────────────────────────────────────────

/** `campaign` → `name`, `human` → `humans`, `version: 2`, and `types:` out (into schema notes). Comments stay. */
function migrateConfig(raw: string, schemaDir: string): string {
  const doc = parseDocument(raw);
  const js = (doc.toJS() ?? {}) as Obj;
  const items = isMap(doc.contents) ? doc.contents.items : [];
  const pair = (key: string) => items.find((p) => isScalar(p.key) && p.key.value === key);

  const campaign = pair("campaign");
  if (campaign && isScalar(campaign.key)) {
    if (doc.has("name")) doc.delete("campaign");
    else campaign.key.value = "name";
  }
  if (doc.has("human")) {
    if (doc.has("humans")) doc.delete("human");
    else setHumans(doc, [{ id: String(js.human ?? "human") }]);
  }
  if (doc.get("version") !== 2) doc.set("version", 2);

  const at = items.findIndex((p) => isScalar(p.key) && p.key.value === "types");
  if (at >= 0) {
    const pointer = ` Entity types are notes in ${schemaDir}/types/, one per type (folder, fields, description).`;
    items.splice(at, 1);
    const next = items[at];
    if (next && isScalar(next.key)) {
      next.key.commentBefore = next.key.commentBefore ? `${pointer}\n\n${next.key.commentBefore}` : pointer;
      next.key.spaceBefore = true;
    } else doc.comment = doc.comment ? `${doc.comment}\n${pointer}` : pointer;
  }
  return renderConfig(doc);
}

// ── 2. Type notes ───────────────────────────────────────────────────────────────

/** The v2 type note for one v1 config type: the template's note with the vault's own folder and wording, or a generated one. */
function typeNote(oldName: string, def: Obj, folder: string, base: string | undefined): string {
  const { folder: _folder, description, secret_fields, ...rest } = def;
  const text = typeof description === "string" ? description.trim() : "";
  const secret = asList(secret_fields);
  const withSecrets = (fields: unknown) => {
    const out: Obj = { ...(isObj(fields) ? fields : {}), ...(isObj(rest.fields) ? rest.fields : {}) };
    for (const f of secret) out[f] = { ...(isObj(out[f]) ? out[f] : typeof out[f] === "string" ? { kind: out[f] } : { kind: "text" }), secret: true };
    return out;
  };

  if (base !== undefined) {
    const { data, body } = parseDoc(base);
    const out: Obj = { ...data, ...rest, folder };
    // The v1 default wording gives way to the note's; the human's own wording stays.
    if (text && text !== V1_DESCRIPTIONS[oldName]) out.description = text;
    const fields = withSecrets(data.fields);
    if (Object.keys(fields).length) out.fields = fields;
    return canonical(out) === canonical(data) ? base : renderDoc(out, body);
  }
  const capability = RENAMED[oldName]?.capability ?? CAPABLE[oldName];
  const out: Obj = { folder, ...(capability && !rest.capabilities ? { capabilities: [capability] } : {}), ...rest };
  const fields = withSecrets(undefined);
  if (Object.keys(fields).length) out.fields = fields;
  return renderDoc(out, text ? `${text}\n` : "");
}

async function writeTypeNotes(store: VaultStore, types: Obj, schemaDir: string, ctx: MigrationContext): Promise<Map<string, TypeMove>> {
  const moves = new Map<string, TypeMove>();
  for (const [oldName, raw] of Object.entries(types)) {
    const def = isObj(raw) ? raw : {};
    const r = RENAMED[oldName];
    // A vault that already has a type by the new name keeps the old name (with its capability).
    const name = r && !(r.name in types) ? r.name : oldName;
    const from = String(def.folder ?? oldName).replace(/\/+$/, "");
    const to = r && name === r.name && from === r.from ? r.to : from;
    moves.set(oldName, { name, from, to });
    const path = `${schemaDir}/types/${name}.md`;
    if ((await store.read(path)) !== undefined) {
      ctx.note(`${path} already exists; kept it (the config's \`${oldName}\` entry was not merged)`);
      continue;
    }
    await store.write(path, typeNote(oldName, def, to, ctx.template?.[`${DEFAULT_SCHEMA_FOLDER}/types/${name}.md`]));
    if (name !== oldName) ctx.note(`type \`${oldName}\` is now \`${name}\` (${to}/)`);
  }
  return moves;
}

// ── 3. Kind notes ───────────────────────────────────────────────────────────────

async function writeKindNotes(store: VaultStore, schemaDir: string, ctx: MigrationContext): Promise<void> {
  const prefix = `${DEFAULT_SCHEMA_FOLDER}/kinds/`;
  for (const [path, content] of Object.entries(ctx.template ?? {})) {
    if (!path.startsWith(prefix) || !path.endsWith(".md")) continue;
    const target = `${schemaDir}/kinds/${path.slice(prefix.length)}`;
    if ((await store.read(target)) === undefined) await store.write(target, content);
  }
}

// ── 4. Goal and arc notes ───────────────────────────────────────────────────────

/** A v1 quest's frontmatter and body as a v2 goal's: `deadline` → `due`, the first clock → `progress`, other clocks → objectives. */
function reshapeGoal(path: string, fm: Obj, body: string, ctx: MigrationContext): string {
  const e = parseEntity(path, renderDoc(fm, body));
  const raw = e.fm as Obj;
  const empty = (v: unknown) => v === undefined || v === null || v === "";
  if (empty(raw.due) && !empty(raw.deadline)) raw.due = String(raw.deadline);
  delete raw.deadline;
  const clocks = legacyClocks(e);
  let extra = clocks;
  if (empty(raw.progress) && clocks[0]) {
    raw.progress = { done: clocks[0].filled, total: clocks[0].segments };
    if (empty(raw.due) && clocks[0].deadline) raw.due = clocks[0].deadline;
    extra = clocks.slice(1);
  }
  delete raw.clocks;
  if (extra.length) {
    const objectives = getObjectives(e);
    for (const c of extra) {
      const text = `⏱ ${c.name} ${c.filled}/${c.segments}${c.deadline ? ` · due ${c.deadline}` : ""}`;
      if (!objectives.some((o) => o.text === text)) objectives.push({ text, done: c.filled >= c.segments });
    }
    setObjectives(e, objectives);
    ctx.note(`${path}: clocks ${extra.map((c) => `"${c.name}"`).join(", ")} kept as objectives (a goal has one progress)`);
  }
  e.body = removeRegion(e.body, "clocks");
  return renderEntity(e, { goal: true });
}

async function migrateNotes(store: VaultStore, moves: Map<string, TypeMove>, skip: string[], ctx: MigrationContext): Promise<void> {
  const renamed = [...moves].filter(([old, m]) => old in RENAMED && m.name !== old);
  if (!renamed.length) return;
  const byOld = new Map(renamed);
  for (const path of await store.list("")) {
    if (!path.endsWith(".md") || path.startsWith("_hippo/") || path.startsWith(".") || skip.some((f) => under(path, f))) continue;
    const raw = await store.read(path);
    if (raw === undefined) continue;
    let doc: ReturnType<typeof parseDoc>;
    try {
      doc = parseDoc(raw);
    } catch {
      continue;
    }
    // A note says its type, or takes its folder's.
    const declared = typeof doc.data.type === "string" ? doc.data.type : undefined;
    const old = declared ?? renamed.find(([, m]) => under(path, m.from))?.[0];
    const move = old === undefined ? undefined : byOld.get(old);
    if (!old || !move) continue;
    const fm = { ...doc.data, type: move.name };
    let content: string;
    try {
      content = RENAMED[old]!.capability === "goal" ? reshapeGoal(path, fm, doc.body, ctx) : renderEntity(parseEntity(path, renderDoc(fm, doc.body)), { goal: false });
    } catch (err) {
      ctx.note(`${path}: left as it was (${(err as Error).message})`);
      continue;
    }
    let target = path;
    if (move.to !== move.from && under(path, move.from)) {
      const moved = `${move.to}/${path.slice(move.from.length + 1)}`;
      if ((await store.read(moved)) === undefined) target = moved;
      else ctx.note(`${path}: not moved, ${moved} already exists`);
    }
    if (target !== path) await store.remove(path);
    await store.write(target, content);
  }
  // An emptied v1 folder's .gitkeep moves along, so git keeps the new folder instead.
  for (const [, m] of renamed) {
    if (m.to === m.from) continue;
    const keep = `${m.from}/.gitkeep`;
    if ((await store.read(keep)) === undefined) continue;
    if ((await store.list(m.from)).some((p) => p !== keep)) continue;
    await store.remove(keep);
    if (!(await store.list(m.to)).length) await store.write(`${m.to}/.gitkeep`, "");
  }
}

// ── 5. Templates and dashboards ─────────────────────────────────────────────────

/** A v1 template or dashboard the human changed, with v1 names swapped for v2 ones. */
function patchScaffold(text: string, moves: Map<string, TypeMove>): string {
  let out = text.replace(/^(\s*FROM\b.*)$/gm, (line) => {
    let l = line;
    for (const m of moves.values()) if (m.to !== m.from) l = l.split(`"${m.from}"`).join(`"${m.to}"`);
    return l;
  });
  out = out.replace(/\bdeadline\b/g, "due");
  for (const [old, m] of moves) if (m.name !== old) out = out.replace(new RegExp(`^type: ${old}[ \\t]*$`, "m"), `type: ${m.name}`);
  return out;
}

async function migrateScaffold(store: VaultStore, moves: Map<string, TypeMove>, ctx: MigrationContext): Promise<void> {
  const paths = (await Promise.all(SCAFFOLD_DIRS.map((d) => store.list(d)))).flat().filter((p) => p.endsWith(".md"));
  for (const path of paths) {
    const raw = await store.read(path);
    if (raw === undefined) continue;
    const known = V1_SCAFFOLD[path];
    const rename = SCAFFOLD_RENAMES[basename(path) + ".md"];
    let to = known?.to ?? (rename ? `${path.slice(0, path.lastIndexOf("/"))}/${rename}` : path);
    const fresh = known && raw === known.text ? ctx.template?.[known.to] : undefined;
    const next = fresh ?? patchScaffold(raw, moves);
    if (to !== path && (await store.read(to)) !== undefined) {
      ctx.note(`${path}: not renamed, ${to} already exists`);
      to = path;
    }
    if (to !== path) await store.remove(path);
    if (to !== path || next !== raw) await store.write(to, next);
  }
}

/** Templates the type notes name that the vault never had (they came with the v2 template), from the template. */
async function addMissingTemplates(store: VaultStore, schemaDir: string, ctx: MigrationContext): Promise<void> {
  for (const path of await store.list(`${schemaDir}/types`)) {
    const raw = await store.read(path);
    const template = raw === undefined ? undefined : parseDoc(raw).data.template;
    if (typeof template !== "string" || (await store.read(template)) !== undefined) continue;
    const content = ctx.template?.[template];
    if (content !== undefined) await store.write(template, content);
  }
}

// ── The migration ───────────────────────────────────────────────────────────────

export const v1ToV2: Migration = {
  from: 1,
  to: 2,
  description: "types become schema notes; quest → goal, campaign → arc; deadline → due, clocks → progress; config name and humans",
  async run(store, ctx) {
    const raw = (await store.read(CONFIG_PATH)) ?? "";
    const config = parseConfig(raw);
    const schemaDir = schemaFolder(config);
    const types = (parseDocument(raw).toJS() as Obj | null)?.types;

    const next = migrateConfig(raw, schemaDir);
    if (next !== raw) await store.write(CONFIG_PATH, next);
    const moves = await writeTypeNotes(store, isObj(types) ? types : {}, schemaDir, ctx);
    await writeKindNotes(store, schemaDir, ctx);
    const { inbox, chronicle, disputes, secrets } = config.folders;
    await migrateNotes(store, moves, [inbox, chronicle, disputes, secrets], ctx);
    await migrateScaffold(store, moves, ctx);
    await addMissingTemplates(store, schemaDir, ctx);
  },
};
