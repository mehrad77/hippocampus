import { isMap, isScalar, isSeq, parse as parseYaml, parseDocument, type Document } from "yaml";
import { z } from "zod";
import { CONFIG_PATH, parseConfig, renderConfig } from "./config.ts";
import { VaultError } from "./errors.ts";
import { HANDBOOK_PATH, renderHandbook } from "./handbook.ts";
import { humanText, parseDoc, renderDoc } from "./markdown.ts";
import { RelationDef } from "./schema.ts";
import { DEFAULT_SCHEMA_FOLDER, schemaFolder } from "./schema-registry.ts";
import { bufferedStore, type Change, type VaultStore } from "./store.ts";
import { Vault } from "./vault.ts";

// A preset is a folder of vault files for one way of using Hippocampus (people, developer, …):
// type and kind notes, templates, a few starter notes, and `preset.yaml`. Adding one copies what the
// vault doesn't have yet, merges `merge: true` schema notes into the vault's own, unions its config
// and appends its human sections to the primary human's note. Nothing is ever overwritten without `force`.

export const PRESET_MANIFEST = "preset.yaml";
/** Sections appended to the primary human's note when it has no heading of the same name. */
export const PRESET_HUMAN_SECTIONS = "human-sections.md";

const list = <T extends z.ZodType>(item: T) => z.preprocess((v) => (v == null ? [] : Array.isArray(v) ? v : [v]), z.array(item));

export const PresetManifest = z.object({
  description: z.coerce.string().default(""),
  /** Presets that must be added first. */
  requires: list(z.coerce.string()),
  config: z
    .object({
      domains: list(z.coerce.string()),
      relations: list(RelationDef),
    })
    .prefault({ domains: [], relations: [] }),
});
export type PresetManifest = z.infer<typeof PresetManifest>;

export interface Preset {
  name: string;
  manifest: PresetManifest;
  /** Files by path inside the preset folder (`_hippo/schema/types/archetype.md`, `archetypes/stranger.md`). */
  files: Record<string, string>;
}

/** A preset from its files (`PRESETS[name]` of @hippocampus/template, or a folder read from disk). */
export function loadPreset(name: string, files: Record<string, string>): Preset {
  const raw = files[PRESET_MANIFEST];
  if (raw === undefined) throw new VaultError(`preset "${name}" has no ${PRESET_MANIFEST}`);
  const parsed = PresetManifest.safeParse(parseYaml(raw) ?? {});
  if (!parsed.success) throw new VaultError(`preset "${name}": ${PRESET_MANIFEST} is invalid (${parsed.error.issues[0]?.message ?? "unreadable"})`);
  return { name, manifest: parsed.data, files };
}

/** Name, description and requirements of every bundled preset, for pickers and `hippo preset list`. */
export function presetCatalog(bundle: Record<string, Record<string, string>>): { name: string; description: string; requires: string[] }[] {
  return Object.keys(bundle)
    .sort()
    .map((name) => {
      const { manifest } = loadPreset(name, bundle[name]!);
      return { name, description: manifest.description, requires: manifest.requires };
    });
}

/** The preset `name` from `bundle`, or a VaultError listing the ones there are. */
export function pickPreset(bundle: Record<string, Record<string, string>>, name: string): Preset {
  const files = bundle[name];
  if (!files) throw new VaultError(`no preset "${name}" (available: ${Object.keys(bundle).sort().join(", ") || "none"})`);
  return loadPreset(name, files);
}

export interface ApplyPresetOptions {
  /** The human whose note gets the preset's human sections; default the primary human. */
  human?: string;
  /** Overwrite files the vault already has, and let the preset's definitions win in merged notes. */
  force?: boolean;
}

export interface PresetResult {
  preset: string;
  /** What to write, as one batch (not applied yet). */
  changes: Change[];
  /** Vault paths written from the preset. */
  added: string[];
  /** Vault notes the preset's definitions or sections were merged into. */
  merged: string[];
  /** Vault paths left as they were because the vault already has them. */
  skipped: string[];
  notes: string[];
}

type Fields = Record<string, Record<string, unknown>>;

/** `email: text` → `{ kind: text }`, so field definitions merge key by key. */
function fieldMap(v: unknown): Fields {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).map(([k, f]) => [k, typeof f === "string" ? { kind: f } : f && typeof f === "object" ? (f as Record<string, unknown>) : {}]));
}

const asList = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/**
 * A `merge: true` schema note laid over the vault's note of the same name: fields (and a kind's
 * `data`) merge field by field, capabilities union, statuses merge, other keys fill in where absent.
 * The vault's values win unless `force`. The preset's description joins the vault's intro once.
 */
export function mergeSchemaNote(existing: string, incoming: string, force = false): string {
  const a = parseDoc(existing);
  const { merge: _merge, ...b } = parseDoc(incoming).data;
  const out: Record<string, unknown> = { ...a.data };
  for (const [key, value] of Object.entries(b)) {
    if (key === "fields" || key === "data") {
      const [mine, theirs] = [fieldMap(a.data[key]), fieldMap(value)];
      const merged: Fields = { ...mine };
      for (const [f, def] of Object.entries(theirs)) merged[f] = force ? { ...mine[f], ...def } : { ...def, ...mine[f] };
      out[key] = merged;
    } else if (key === "capabilities") {
      out[key] = [...new Set([...asList(a.data[key]), ...asList(value)].map(String))];
    } else if (key === "statuses" && value && typeof value === "object" && !Array.isArray(value)) {
      const mine = a.data[key] && typeof a.data[key] === "object" && !Array.isArray(a.data[key]) ? (a.data[key] as Record<string, unknown>) : {};
      out[key] = force ? { ...mine, ...value } : { ...value, ...mine };
    } else if (force || a.data[key] === undefined) {
      out[key] = value;
    }
  }
  const intro = parseDoc(incoming).body.trim();
  let body = a.body;
  if (intro && !body.includes(intro)) {
    // Into the description (before the first `##`), so prompts read it with the rest.
    const at = /^## /m.exec(body)?.index ?? body.length;
    const head = body.slice(0, at).replace(/\s+$/, "");
    body = `${head ? `${head}\n\n` : ""}${intro}\n${at < body.length ? `\n${body.slice(at)}` : ""}`;
  }
  return renderDoc(out, body);
}

const headingsOf = (text: string) => new Set([...text.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)].map((m) => m[1]!.trim().toLowerCase()));

/** `## Heading` sections of `sections` whose heading `body` lacks, appended to it. */
export function appendSections(body: string, sections: string): { body: string; added: string[] } {
  const have = headingsOf(humanText(body));
  const added: string[] = [];
  const parts: string[] = [];
  for (const chunk of sections.split(/^(?=## )/m)) {
    const head = /^##[ \t]+(.+?)[ \t]*$/m.exec(chunk)?.[1]?.trim();
    if (!head || have.has(head.toLowerCase())) continue;
    added.push(head);
    parts.push(chunk.trim());
  }
  if (!parts.length) return { body, added };
  return { body: `${body.replace(/\s+$/, "")}\n\n${parts.join("\n\n")}\n`, added };
}

/** Add `items` to a YAML list at `key` (made flow-style when new), skipping ones `same` finds. Returns whether it changed. */
function unionList(doc: Document, key: string, items: unknown[], same: (node: unknown, item: unknown) => boolean): boolean {
  if (!items.length) return false;
  let seq = doc.get(key, true);
  if (!isSeq(seq)) {
    seq = doc.createNode([], { flow: true });
    doc.set(key, seq);
  }
  let changed = false;
  for (const item of items) {
    if ((seq as { items: unknown[] }).items.some((n) => same(n, item))) continue;
    const node = doc.createNode(item, { flow: true });
    (seq as { items: unknown[] }).items.push(node);
    changed = true;
  }
  return changed;
}

const scalarValue = (n: unknown) => (isScalar(n) ? String(n.value) : undefined);
const relationName = (n: unknown) => (isMap(n) ? scalarValue(n.get("name", true)) : scalarValue(n));

/** The config with the preset's domains, relations and name added, comments kept; undefined when nothing changes. */
function patchConfig(raw: string, preset: Preset): string | undefined {
  const doc = parseDocument(raw);
  const { domains, relations } = preset.manifest.config;
  let changed = unionList(doc, "domains", domains, (n, d) => scalarValue(n) === d);
  changed = unionList(doc, "relations", relations, (n, r) => relationName(n) === (typeof r === "string" ? r : (r as { name: string }).name)) || changed;
  changed = unionList(doc, "presets", [preset.name], (n, p) => scalarValue(n) === p) || changed;
  return changed ? renderConfig(doc) : undefined;
}

/**
 * Add a preset to the vault in `store`, without writing: returns the changes as one batch. Files
 * the vault already has are skipped (or overwritten with `force`); `merge: true` type and kind notes
 * merge into the vault's own; the config gains the preset's domains and relations and lists it under
 * `presets:`; the primary human's note gains the preset's human sections it lacks. New notes are
 * normalized and the Handbook re-rendered, as `hippo fmt` would.
 */
export async function applyPreset(store: VaultStore, preset: Preset, opts: ApplyPresetOptions = {}): Promise<PresetResult> {
  const result: PresetResult = { preset: preset.name, changes: [], added: [], merged: [], skipped: [], notes: [] };
  const buffer = bufferedStore(store);
  const raw = await buffer.store.read(CONFIG_PATH);
  if (raw === undefined) throw new VaultError(`no ${CONFIG_PATH}; is this a vault?`);
  const config = parseConfig(raw);
  const missing = preset.manifest.requires.filter((r) => !config.presets.includes(r));
  if (missing.length) throw new VaultError(`preset "${preset.name}" needs ${missing.map((m) => `"${m}"`).join(", ")} first`);
  // Load once up front, so an old or newer vault is refused before anything is planned.
  await Vault.load(buffer.store);

  const schema = schemaFolder(config);
  const target = (path: string) => (path.startsWith(`${DEFAULT_SCHEMA_FOLDER}/`) ? `${schema}/${path.slice(DEFAULT_SCHEMA_FOLDER.length + 1)}` : path);
  const isSchemaNote = (path: string) => /^(types|kinds)\/[^/]+\.md$/.test(path.slice(schema.length + 1)) && path.startsWith(`${schema}/`);
  const entityPaths: string[] = [];

  for (const [src, content] of Object.entries(preset.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (src === PRESET_MANIFEST || src === PRESET_HUMAN_SECTIONS) continue;
    const path = target(src);
    const existing = await buffer.store.read(path);
    if (path.endsWith("/.gitkeep")) {
      // Only for a folder that would otherwise be missing.
      const folder = path.slice(0, -"/.gitkeep".length);
      if (existing === undefined && !(await buffer.store.list(folder)).length) {
        await buffer.store.write(path, content);
        result.added.push(path);
      }
      continue;
    }
    if (isSchemaNote(path) && parseDoc(content).data.merge === true) {
      if (existing === undefined) {
        result.notes.push(`${path}: the vault has no such type or kind to merge the preset's definitions into; skipped`);
        result.skipped.push(path);
        continue;
      }
      const merged = mergeSchemaNote(existing, content, opts.force);
      if (merged !== existing) {
        await buffer.store.write(path, merged);
        result.merged.push(path);
      }
      continue;
    }
    if (existing !== undefined && !opts.force) {
      if (existing !== content) result.skipped.push(path);
      continue;
    }
    if (existing === content) continue;
    await buffer.store.write(path, content);
    result.added.push(path);
    if (path.endsWith(".md") && !path.startsWith("_hippo/")) entityPaths.push(path);
  }

  const patched = patchConfig(raw, preset);
  if (patched !== undefined) await buffer.store.write(CONFIG_PATH, patched);

  const vault = await Vault.load(buffer.store);
  const sections = preset.files[PRESET_HUMAN_SECTIONS];
  if (sections?.trim()) {
    const id = opts.human ?? config.humans[0]!.id;
    const note = vault.entities.get(id) ?? vault.resolve(id);
    if (!note) result.notes.push(`no note for human "${id}"; its sections from the preset weren't added`);
    else {
      const current = (await buffer.store.read(note.path))!;
      const { data, body } = parseDoc(current);
      const next = appendSections(body, sections);
      if (next.added.length) {
        await buffer.store.write(note.path, renderDoc(data, next.body));
        result.merged.push(note.path);
        result.notes.push(`${note.path}: added ${next.added.map((h) => `## ${h}`).join(", ")}`);
      }
    }
  }

  // Normalize the notes the preset brought, and show its types and kinds in the Handbook.
  const after = await Vault.load(buffer.store);
  for (const e of after.entities.values()) if (entityPaths.includes(e.path)) after.markDirty(e);
  after.writeFile(HANDBOOK_PATH, renderHandbook(after));
  await after.flush();
  result.notes.push(...after.warnings.filter((w) => !vault.warnings.includes(w)));

  result.changes = await buffer.changes();
  return result;
}

/** Apply `presets` in order to the vault in `store`, writing each one's changes. */
export async function applyPresets(store: VaultStore, bundle: Record<string, Record<string, string>>, names: string[], opts: ApplyPresetOptions = {}): Promise<PresetResult[]> {
  const out: PresetResult[] = [];
  for (const name of names) {
    const r = await applyPreset(store, pickPreset(bundle, name), opts);
    for (const c of r.changes) {
      if ("remove" in c) await store.remove(c.path);
      else await store.write(c.path, c.content);
    }
    out.push(r);
  }
  return out;
}
