import { parseDocument } from "yaml";
import { CONFIG_PATH } from "./config.ts";
import { HANDBOOK_PATH, renderHandbook } from "./handbook.ts";
import { parseDoc, renderDoc } from "./markdown.ts";
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

/** The campaign settings a new vault's `_hippo/config.yaml` is filled in with. */
export interface VaultSettings {
  campaign?: string;
  human?: string;
  timezone?: string;
  domains?: string[];
  /** age public key for `secrets.recipient`. */
  recipient?: string;
}

export interface BuildVaultOptions extends VaultSettings {
  /** Seed files (an example campaign), laid over the template. */
  seed?: Record<string, string>;
  /** The vault's clock during the build, for reproducible output. */
  now?: Date;
}

/** Throws on settings that would make an unusable vault, before anything is written. */
export function validateVaultSettings(s: VaultSettings): void {
  if (s.human !== undefined && !SLUG.test(s.human)) throw new Error(`human "${s.human}" must be an id: lowercase letters, digits and dashes`);
  if (s.timezone !== undefined && !validTimezone(s.timezone)) throw new Error(`unknown timezone "${s.timezone}" (use an IANA name like Europe/Lisbon)`);
  for (const d of s.domains ?? []) if (!SLUG.test(d)) throw new Error(`domain "${d}" must be lowercase letters, digits and dashes`);
}

/**
 * The files of a new vault: the template with the seed over it, the config filled in, the
 * player character placed, every note normalized and the Handbook rendered. Pure over file maps,
 * so the CLI (filesystem) and the hosted app (GitHub API, no filesystem) build the same vault.
 */
export async function buildVaultFiles(template: Record<string, string>, opts: BuildVaultOptions = {}): Promise<Record<string, string>> {
  validateVaultSettings(opts);
  const store = new MemoryStore({ ...template, ...opts.seed });
  const raw = await store.read(CONFIG_PATH);
  if (raw === undefined) throw new Error(`the template has no ${CONFIG_PATH}`);
  await store.write(CONFIG_PATH, patchConfig(raw, opts));
  await placePlayerCharacter(store);

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
  if (s.campaign !== undefined) doc.set("campaign", s.campaign);
  if (s.human !== undefined) doc.set("human", s.human);
  if (s.timezone !== undefined) doc.set("timezone", s.timezone);
  if (s.domains !== undefined) doc.set("domains", doc.createNode(s.domains, { flow: true }));
  if (s.recipient !== undefined) doc.setIn(["secrets", "recipient"], s.recipient);
  return renderConfig(doc);
}

/** No line folding, so the template's one-line flow maps and lists stay on one line. */
export const renderConfig = (doc: ReturnType<typeof parseDocument>) => doc.toString({ lineWidth: 0, flowCollectionPadding: false });

const titleCase = (id: string) => id.replace(/(^|-)([a-z])/g, (_, dash: string, c: string) => `${dash ? " " : ""}${c.toUpperCase()}`).replace(/-/g, " ");

/**
 * The template's placeholder PC is `characters/player.md`. When the human has another id, it
 * becomes theirs (`characters/<human>.md`), unless a seed already brought the human's own note.
 */
export async function placePlayerCharacter(store: VaultStore): Promise<void> {
  const PC = "characters/player.md";
  const vault = await Vault.load(store);
  const human = vault.config.human;
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
