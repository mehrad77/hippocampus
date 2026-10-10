import { VaultError } from "./errors.ts";
import { parseDoc } from "./markdown.ts";
import { Behaviour, FieldDef, KindDef, TypeDef, type Capability, type HippoConfig } from "./schema.ts";
import type { VaultStore } from "./store.ts";
import { parseFactKey } from "./text.ts";

export const DEFAULT_SCHEMA_FOLDER = "_hippo/schema";
/** How many ancestors a type may have. Deeper chains are cut off with a warning. */
export const MAX_EXTENDS_DEPTH = 3;

/**
 * v1 vaults named their special types; v2 vaults declare capabilities. This is the only place in
 * the code that knows those names: everything else asks the registry for a capability.
 */
const LEGACY_CAPABILITIES: Record<string, Capability> = { quest: "goal", party: "actor", campaign: "arc" };

/** Bullets under a note's `## Is` / `## Is not` headings, shown to the curator as examples. */
export interface Examples {
  is: string[];
  isNot: string[];
}

export interface ResolvedType {
  name: string;
  folder: string;
  description: string;
  extends?: string;
  /** Own and inherited. */
  capabilities: Capability[];
  inheritable: boolean;
  /** Own and inherited; the child's definition of a field wins. */
  fields: Record<string, FieldDef>;
  /** Status words mapped to core states, own or inherited. */
  statuses?: Record<string, string>;
  template?: string;
  label?: string;
  codexLabel?: string;
  examples: Examples;
}

export interface ResolvedKind {
  name: string;
  behaviour: Behaviour;
  aliasOf?: string;
  text: NonNullable<KindDef["text"]>;
  gistMax?: number;
  data: Record<string, FieldDef>;
  countsAsContact: boolean;
  reducers: string[];
  description: string;
  examples: Examples;
}

/** Kinds every vault has. Notes and inline config refine them key by key. */
const CORE_KINDS: Record<string, KindDef> = {
  observation: { behaviour: "observation", description: "Something noticed or learned." },
  fact: { behaviour: "fact", description: "A specific value about something: a date, an amount, an address, an id." },
  decision: { behaviour: "decision", description: "A choice that was made, and why." },
  question: { behaviour: "question", description: "Something still unknown that someone should find out." },
  task: { behaviour: "task", description: "Something to do, with an owner or a due date." },
  interaction: { behaviour: "interaction", text: "optional", counts_as_contact: true, description: "A contact with someone: a call, a meeting, a message." },
  beat: { alias_of: "observation", description: "A story beat: something that happened, told for the story." },
};

interface SourceNote {
  data: Record<string, unknown>;
  body: string;
}

/** Type and kind notes found in the vault, by name. */
export interface SchemaNotes {
  types: Map<string, SourceNote>;
  kinds: Map<string, SourceNote>;
}

export function schemaFolder(config: HippoConfig): string {
  return (config.folders.schema ?? DEFAULT_SCHEMA_FOLDER).replace(/\/+$/, "");
}

const noteName = (path: string) => path.slice(path.lastIndexOf("/") + 1, -".md".length);

async function readNotes(store: VaultStore, folder: string): Promise<Map<string, SourceNote>> {
  const out = new Map<string, SourceNote>();
  for (const path of await store.list(folder)) {
    if (!path.endsWith(".md") || noteName(path).startsWith("_")) continue;
    const raw = await store.read(path);
    if (raw !== undefined) out.set(noteName(path), parseDoc(raw));
  }
  return out;
}

/** The vault's types and kinds: notes under `folders.schema`, then inline config, then code defaults. */
export async function loadSchema(store: VaultStore, config: HippoConfig): Promise<SchemaRegistry> {
  const folder = schemaFolder(config);
  return buildSchema(config, { types: await readNotes(store, `${folder}/types`), kinds: await readNotes(store, `${folder}/kinds`) });
}

/** Note body → description (text before the first `##`) and `## Is` / `## Is not` bullets. */
function parseBody(body: string): { description: string; examples: Examples } {
  const clean = body.replace(/<!--[\s\S]*?-->/g, "").replace(/%%[\s\S]*?%%/g, "");
  const [intro = "", ...sections] = clean.split(/^## +/m);
  const examples: Examples = { is: [], isNot: [] };
  for (const section of sections) {
    const [head = "", ...lines] = section.split("\n");
    const bullets = lines.map((l) => /^\s*[-*] +(.+)$/.exec(l)?.[1]?.trim()).filter((b): b is string => !!b);
    const h = head.trim().toLowerCase();
    if (h === "is") examples.is.push(...bullets);
    else if (h === "is not") examples.isNot.push(...bullets);
  }
  return { description: intro.replace(/^# .*$/m, "").trim(), examples };
}

/** Keys the inline entry actually sets, so zod's `undefined`s don't erase a note's values. */
function defined<T extends object>(o: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const normalizeField = (f: FieldDef): FieldDef => (f.identity_key ? { ...f, confidential: true } : f);

interface RawType {
  def: TypeDef;
  examples: Examples;
}

function collectTypes(config: HippoConfig, notes: Map<string, SourceNote>, warn: (w: string) => void): Map<string, RawType> {
  const raw = new Map<string, RawType>();
  for (const [name, note] of notes) {
    const parsed = TypeDef.safeParse(note.data);
    if (!parsed.success) {
      warn(`skipped type note "${name}": ${parsed.error.issues[0]?.message ?? "invalid"}`);
      continue;
    }
    const { description, examples } = parseBody(note.body);
    raw.set(name, { def: { ...parsed.data, description: parsed.data.description ?? (description || undefined) }, examples });
  }
  for (const [name, inline] of Object.entries(config.types ?? {})) {
    const base = raw.get(name);
    const def = { ...base?.def, ...defined(inline) } as TypeDef;
    if (base?.def.fields && inline.fields) def.fields = { ...base.def.fields, ...inline.fields };
    raw.set(name, { def, examples: base?.examples ?? { is: [], isNot: [] } });
  }
  const legacy = config.version < 2;
  for (const [name, { def }] of raw) {
    const fields: Record<string, FieldDef> = {};
    for (const [f, fd] of Object.entries(def.fields ?? {})) fields[f] = normalizeField(fd);
    for (const f of def.secret_fields ?? []) fields[f] = { ...(fields[f] ?? { kind: "text" }), secret: true };
    def.fields = fields;
    const mapped = LEGACY_CAPABILITIES[name];
    if (legacy && mapped && !def.capabilities?.length) def.capabilities = [mapped];
  }
  return raw;
}

/** `name` and its ancestors, nearest first, cut at cycles, unknown parents and `MAX_EXTENDS_DEPTH`. */
function ancestry(name: string, raw: Map<string, RawType>, warn: (w: string) => void): RawType[] {
  const chain: RawType[] = [];
  const seen = [name];
  for (let parent = raw.get(name)?.def.extends; parent; parent = raw.get(parent)?.def.extends) {
    if (seen.includes(parent)) {
      warn(`type "${name}": extends cycle ${[...seen, parent].join(" → ")}; ignoring the repeat`);
      break;
    }
    const p = raw.get(parent);
    if (!p) {
      warn(`type "${seen.at(-1)}" extends unknown type "${parent}"`);
      break;
    }
    if (chain.length >= MAX_EXTENDS_DEPTH) {
      warn(`type "${name}": extends chain deeper than ${MAX_EXTENDS_DEPTH} levels; ignoring "${parent}" and above`);
      break;
    }
    chain.push(p);
    seen.push(parent);
  }
  return chain;
}

function resolveTypes(config: HippoConfig, notes: Map<string, SourceNote>, warn: (w: string) => void): ResolvedType[] {
  const raw = collectTypes(config, notes, warn);
  return [...raw].map(([name, { def, examples }]) => {
    // Farthest ancestor first, so nearer definitions overwrite.
    const lineage = [...ancestry(name, raw, warn)].reverse().map((r) => r.def);
    const fields: Record<string, FieldDef> = {};
    const capabilities = new Set<Capability>();
    let statuses: Record<string, string> | undefined;
    let template: string | undefined;
    for (const d of [...lineage, def]) {
      Object.assign(fields, d.fields);
      for (const c of d.capabilities ?? []) capabilities.add(c);
      statuses = d.statuses ?? statuses;
      template = d.template ?? template;
    }
    if (!def.folder) warn(`type "${name}" has no folder; using "${name}/"`);
    return {
      name,
      folder: (def.folder ?? name).replace(/\/+$/, ""),
      description: def.description ?? "",
      extends: def.extends,
      capabilities: [...capabilities],
      inheritable: def.inheritable ?? false,
      fields,
      statuses,
      template,
      label: def.label,
      codexLabel: def.codex_label,
      examples,
    };
  });
}

function resolveKinds(config: HippoConfig, notes: Map<string, SourceNote>, warn: (w: string) => void): ResolvedKind[] {
  const raw = new Map<string, { def: KindDef; examples: Examples }>();
  for (const [name, def] of Object.entries(CORE_KINDS)) raw.set(name, { def, examples: { is: [], isNot: [] } });
  for (const [rawName, note] of notes) {
    const name = rawName.toLowerCase();
    const parsed = KindDef.safeParse(note.data);
    if (!parsed.success) {
      warn(`skipped kind note "${rawName}": ${parsed.error.issues[0]?.message ?? "invalid"}`);
      continue;
    }
    const { description, examples } = parseBody(note.body);
    const base = raw.get(name)?.def;
    raw.set(name, { def: { ...base, ...defined({ ...parsed.data, description: parsed.data.description ?? (description || undefined) }) } as KindDef, examples });
  }
  for (const [rawName, inline] of Object.entries(config.kinds ?? {})) {
    const name = rawName.toLowerCase();
    const base = raw.get(name);
    raw.set(name, { def: { ...base?.def, ...defined(inline) } as KindDef, examples: base?.examples ?? { is: [], isNot: [] } });
  }

  const target = (name: string): KindDef | undefined => {
    const seen = new Set<string>();
    let def = raw.get(name)?.def;
    while (def?.alias_of && !def.behaviour) {
      const next = def.alias_of.toLowerCase();
      if (seen.has(next) || !raw.has(next)) {
        warn(`kind "${name}": alias_of "${def.alias_of}" ${seen.has(next) ? "loops" : "is unknown"}`);
        return undefined;
      }
      seen.add(next);
      def = raw.get(next)?.def;
    }
    return def;
  };
  return [...raw].map(([name, { def, examples }]) => {
    const base = def.alias_of ? target(name) : undefined;
    const behaviour = def.behaviour ?? base?.behaviour ?? (Behaviour.safeParse(name).success ? (name as Behaviour) : undefined);
    if (!behaviour) warn(`kind "${name}" has no behaviour; treating it as an observation`);
    return {
      name,
      behaviour: behaviour ?? "observation",
      aliasOf: def.alias_of?.toLowerCase(),
      text: def.text ?? base?.text ?? "required",
      gistMax: def.gist_max ?? base?.gist_max,
      data: Object.fromEntries(Object.entries({ ...base?.data, ...def.data }).map(([k, f]) => [k, normalizeField(f)])),
      countsAsContact: def.counts_as_contact ?? base?.counts_as_contact ?? false,
      reducers: def.reducers ?? base?.reducers ?? [],
      description: def.description ?? base?.description ?? "",
      examples,
    };
  });
}

/** Builds the registry from config and already-read notes (pure, so tests need no store). */
export function buildSchema(config: HippoConfig, notes: SchemaNotes): SchemaRegistry {
  const warnings = new Set<string>();
  const warn = (w: string) => void warnings.add(w);
  const types = resolveTypes(config, notes.types, warn);
  if (!types.length) {
    throw new VaultError(`the vault defines no entity types: add \`types:\` to _hippo/config.yaml or notes to ${schemaFolder(config)}/types/`);
  }
  return new SchemaRegistry(types, resolveKinds(config, notes.kinds, warn), [...warnings]);
}

/** Read-only answers about the vault's types and kinds. Code asks for capabilities, never type names. */
export class SchemaRegistry {
  private readonly typeMap: Map<string, ResolvedType>;
  private readonly kindMap: Map<string, ResolvedKind>;
  /** Longest folder first, so a nested type folder wins over its parent. */
  private readonly byFolder: ResolvedType[];

  constructor(
    types: ResolvedType[],
    kinds: ResolvedKind[],
    readonly warnings: string[] = [],
  ) {
    this.typeMap = new Map(types.map((t) => [t.name, t]));
    this.kindMap = new Map(kinds.map((k) => [k.name, k]));
    this.byFolder = [...types].sort((a, b) => b.folder.length - a.folder.length);
  }

  types(): ResolvedType[] {
    return [...this.typeMap.values()];
  }

  type(name: string | undefined): ResolvedType | undefined {
    return name === undefined ? undefined : this.typeMap.get(name);
  }

  has(type: string | undefined, cap: Capability): boolean {
    return !!this.type(type)?.capabilities.includes(cap);
  }

  typesWith(cap: Capability): string[] {
    return this.types()
      .filter((t) => t.capabilities.includes(cap))
      .map((t) => t.name);
  }

  /** The type new entities with `cap` get: the first that has it, preferring one that extends nothing. */
  defaultTypeFor(cap: Capability): string | undefined {
    const candidates = this.types().filter((t) => t.capabilities.includes(cap));
    return (candidates.find((t) => !t.extends) ?? candidates[0])?.name;
  }

  /** The definition of `field`; a scoped `facts:` key (`field@scope`) has its field's definition. */
  fieldDef(type: string | undefined, field: string): FieldDef | undefined {
    return this.type(type)?.fields[parseFactKey(field).field];
  }

  isSecretField(type: string | undefined, field: string): boolean {
    return !!this.fieldDef(type, field)?.secret;
  }

  kinds(): ResolvedKind[] {
    return [...this.kindMap.values()];
  }

  /** Resolve an episode's kind. Unknown kinds count as observations, flagged `unknown` so callers can warn. */
  kind(raw: string | undefined): { name: string; def: ResolvedKind; unknown: boolean } {
    const name = (raw ?? "").trim().toLowerCase() || "observation";
    const def = this.kindMap.get(name);
    if (def) return { name, def, unknown: false };
    return { name: "observation", def: this.kindMap.get("observation")!, unknown: true };
  }

  /** Every type's folder, in definition order. */
  folders(): { type: string; folder: string }[] {
    return this.types().map((t) => ({ type: t.name, folder: t.folder }));
  }

  /** The type whose folder holds the note at `path`. */
  typeAt(path: string): string | undefined {
    if (!path.endsWith(".md")) return undefined;
    return this.byFolder.find((t) => path.startsWith(`${t.folder}/`))?.name;
  }
}
