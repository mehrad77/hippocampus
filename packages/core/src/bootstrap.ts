import { parseDocument } from "yaml";
import { CONFIG_PATH, renderConfig, setHumans } from "./config.ts";
import { HANDBOOK_PATH, renderHandbook } from "./handbook.ts";
import { parseDoc, renderDoc } from "./markdown.ts";
import { applyPresets } from "./presets.ts";
import type { HumanDef } from "./schema.ts";
import { MemoryStore, type VaultStore } from "./store.ts";
import { Vault } from "./vault.ts";

/** Ids of the human, agents and domains: lowercase letters, digits and dashes. */
export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A human as the settings give it; `domains` may be left out. */
export type HumanSetting = Pick<HumanDef, "id" | "github"> & { domains?: string[] };

/** The campaign settings a new vault's `_hippo/config.yaml` is filled in with. */
export interface VaultSettings {
  /** What the memory is about (written to the config's `name`, or `campaign` in a v1 config). */
  campaign?: string;
  /** Shorthand for `humans: [{ id: human }]`. */
  human?: string;
  /** The vault's humans, primary first; wins over `human`. */
  humans?: HumanSetting[];
  timezone?: string;
  domains?: string[];
  /** age public key for `secrets.recipient`. */
  recipient?: string;
}

export interface BuildVaultOptions extends VaultSettings {
  /** Seed files (an example campaign), laid over the template. */
  seed?: Record<string, string>;
  /** Presets to add, in order (names in `presetFiles`). */
  presets?: string[];
  /** The presets there are, by name (`PRESETS` from @hippocampus/template). */
  presetFiles?: Record<string, Record<string, string>>;
  /** The vault's clock during the build, for reproducible output. */
  now?: Date;
}

/** Throws on settings that would make an unusable vault, before anything is written. */
export function validateVaultSettings(s: VaultSettings): void {
  if (s.human !== undefined && !SLUG.test(s.human)) throw new Error(`human "${s.human}" must be an id: lowercase letters, digits and dashes`);
  if (s.humans !== undefined && !s.humans.length) throw new Error("a vault needs at least one human");
  const seen = new Set<string>();
  for (const h of s.humans ?? []) {
    if (!SLUG.test(h.id)) throw new Error(`human "${h.id}" must be an id: lowercase letters, digits and dashes`);
    if (seen.has(h.id)) throw new Error(`human "${h.id}" is listed twice`);
    seen.add(h.id);
    for (const d of h.domains ?? []) if (!SLUG.test(d)) throw new Error(`domain "${d}" of human "${h.id}" must be lowercase letters, digits and dashes`);
  }
  if (s.timezone !== undefined && !validTimezone(s.timezone)) throw new Error(`unknown timezone "${s.timezone}" (use an IANA name like Europe/Lisbon)`);
  for (const d of s.domains ?? []) if (!SLUG.test(d)) throw new Error(`domain "${d}" must be lowercase letters, digits and dashes`);
}

/** Throws unless every name is a preset of `bundle`, each once. */
export function validatePresetNames(names: string[], bundle: Record<string, Record<string, string>>): void {
  const seen = new Set<string>();
  for (const n of names) {
    if (!bundle[n]) throw new Error(`no preset "${n}" (available: ${Object.keys(bundle).sort().join(", ") || "none"})`);
    if (seen.has(n)) throw new Error(`preset "${n}" is listed twice`);
    seen.add(n);
  }
}

/**
 * The files of a new vault: the template with the seed over it, the config filled in, the
 * player character placed, every note normalized and the Handbook rendered. Pure over file maps,
 * so the CLI (filesystem) and the hosted app (GitHub API, no filesystem) build the same vault.
 */
export async function buildVaultFiles(template: Record<string, string>, opts: BuildVaultOptions = {}): Promise<Record<string, string>> {
  validateVaultSettings(opts);
  if (opts.presets) validatePresetNames(opts.presets, opts.presetFiles ?? {});
  const store = new MemoryStore({ ...template, ...opts.seed });
  const raw = await store.read(CONFIG_PATH);
  if (raw === undefined) throw new Error(`the template has no ${CONFIG_PATH}`);
  await store.write(CONFIG_PATH, patchConfig(raw, opts));
  await placePlayerCharacter(store);
  if (opts.presets?.length) await applyPresets(store, opts.presetFiles ?? {}, opts.presets);

  const now = opts.now;
  const vault = await Vault.load(store, now ? { now: () => now } : {});
  for (const e of vault.entities.values()) vault.markDirty(e);
  vault.writeFile(HANDBOOK_PATH, renderHandbook(vault));
  await vault.flush();
  return Object.fromEntries([...store.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Set the given settings in a `_hippo/config.yaml`, keeping its comments and layout. */
export function patchConfig(raw: string, s: VaultSettings): string {
  const doc = parseDocument(raw);
  if (s.campaign !== undefined) doc.set(doc.has("name") || !doc.has("campaign") ? "name" : "campaign", s.campaign);
  const humans = settingsHumans(s);
  if (humans) setHumans(doc, humans);
  if (s.timezone !== undefined) doc.set("timezone", s.timezone);
  if (s.domains !== undefined) doc.set("domains", doc.createNode(s.domains, { flow: true }));
  if (s.recipient !== undefined) doc.setIn(["secrets", "recipient"], s.recipient);
  return renderConfig(doc);
}

/** The humans the settings name, if any: `humans`, else `human` as the only one. */
export function settingsHumans(s: VaultSettings): HumanSetting[] | undefined {
  if (s.humans?.length) return s.humans;
  return s.human === undefined ? undefined : [{ id: s.human }];
}

const titleCase = (id: string) => id.replace(/(^|-)([a-z])/g, (_, dash: string, c: string) => `${dash ? " " : ""}${c.toUpperCase()}`).replace(/-/g, " ");

/**
 * The template's placeholder PC is `characters/player.md`. When the human has another id, it
 * becomes theirs (`characters/<human>.md`), unless a seed already brought the human's own note.
 */
export async function placePlayerCharacter(store: VaultStore): Promise<void> {
  const PC = "characters/player.md";
  const vault = await Vault.load(store);
  const human = vault.config.humans[0]!.id;
  const pc = await store.read(PC);
  if (human === "player" || pc === undefined) return;
  if (vault.entities.has(human)) {
    await store.remove(PC);
    return;
  }
  const { data, body } = parseDoc(pc);
  await store.write(`characters/${human}.md`, renderDoc({ ...data, title: titleCase(human) }, body));
  await store.remove(PC);
}
