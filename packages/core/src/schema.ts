import { z } from "zod";

/** Optional field that also accepts YAML null / empty string (common in hand-written notes and templates). */
const opt = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === null || v === "" ? undefined : v), schema.optional());

// ── Facts ──────────────────────────────────────────────────────────────────────

export const FactValue = z.union([z.string(), z.number(), z.boolean()]);
export type FactValue = z.infer<typeof FactValue>;

/** rumor → unverified; canon → accepted truth; disputed → awaiting a ruling; retconned → superseded. */
export const FactStatus = z.enum(["rumor", "canon", "disputed", "retconned"]);
export type FactStatus = z.infer<typeof FactStatus>;

/** Why a value left the current slot: overruled by someone, closed by a newer one, corrected by its source, or ruled on by the human. */
export const PriorWhy = z.enum(["replaced", "succeeded", "retconned", "ruled"]);
export type PriorWhy = z.infer<typeof PriorWhy>;

export const PriorValue = z.object({
  value: FactValue,
  by: z.string().optional(),
  at: z.string().optional(),
  valid_from: opt(z.coerce.string()),
  valid_until: opt(z.coerce.string()),
  why: PriorWhy.optional().catch(undefined),
});
export type PriorValue = z.infer<typeof PriorValue>;

const confidence = z.coerce.number().min(0).max(1).optional().catch(undefined);

const FactObject = z.object({
  value: FactValue,
  status: FactStatus.default("canon"),
  /** Party id of whoever asserted the current value. Missing = written by the human. */
  by: z.string().optional(),
  /** ISO timestamp of the latest observation/verification. */
  at: z.string().optional(),
  /** Episode ids that support the current value. */
  src: z.array(z.string()).default([]),
  /** Previous values, most recent last. */
  was: z.array(PriorValue).optional(),
  /** While a rumor: distinct agents who reported this value (for promotion to canon). */
  seen_by: z.array(z.string()).optional(),
  /** When the value started and stopped being true (ISO dates), if known. */
  valid_from: opt(z.coerce.string()),
  valid_until: opt(z.coerce.string()),
  /** The reporter's own confidence, 0–1. */
  confidence,
  /** Kept out of search, prompts and summaries, like a `confidential` field. */
  confidential: opt(z.boolean()),
});

/** Humans may write `facts: { phone: "+90…" }` directly; that shorthand is canon by the human. */
export const Fact = z.preprocess(
  (v) => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : { value: v ?? "" }),
  FactObject,
);
export type Fact = z.infer<typeof FactObject>;

// ── Entities ───────────────────────────────────────────────────────────────────

export const Relation = z.object({
  rel: z.string(),
  target: z.string(),
  /** What the source is in the relation (`works_at` → `engineer`). */
  role: opt(z.coerce.string()),
  /** Context the relation holds in, like a fact's `@scope`. */
  scope: opt(z.coerce.string()),
  valid_from: opt(z.coerce.string()),
  valid_until: opt(z.coerce.string()),
  by: z.string().optional(),
  src: z.array(z.string()).optional(),
});
export type Relation = z.infer<typeof Relation>;

export const Clock = z.object({
  name: z.string(),
  segments: z.number().int().positive().default(6),
  filled: z.number().int().nonnegative().default(0),
  deadline: opt(z.coerce.string()),
});
export type Clock = z.infer<typeof Clock>;

export const QuestStatus = z.enum(["active", "blocked", "done", "failed", "dormant"]);
export type QuestStatus = z.infer<typeof QuestStatus>;

const stringList = z.preprocess((v) => (v == null ? [] : Array.isArray(v) ? v : [v]), z.array(z.coerce.string()));

export const EntityFrontmatter = z.looseObject({
  id: opt(z.string()),
  type: z.string(),
  title: opt(z.coerce.string()),
  aliases: stringList.default([]),
  tags: stringList.default([]),
  relations: z.array(Relation).default([]),
  facts: z.record(z.string(), Fact).default({}),
  // quest
  status: opt(z.coerce.string()),
  owner: opt(z.coerce.string()),
  deadline: opt(z.coerce.string()),
  clocks: opt(z.array(Clock)),
  // party
  lane: opt(z.coerce.string()),
  authority: opt(stringList),
  host: opt(z.coerce.string()),
  // bookkeeping
  updated: z.string().optional(),
  updated_by: z.string().optional(),
});
export type EntityFrontmatter = z.infer<typeof EntityFrontmatter>;

// ── Episodes (raw inbox memories) ─────────────────────────────────────────────

export const EpisodeKind = z.enum(["observation", "fact", "decision", "task", "beat", "question"]);
export type EpisodeKind = z.infer<typeof EpisodeKind>;

export const EpisodeFrontmatter = z.looseObject({
  id: z.string().optional(),
  agent: z.string().optional(),
  kind: EpisodeKind.catch("observation").default("observation"),
  at: z.coerce.string().optional(),
  about: stringList.default([]),
  confidence: z.coerce.number().min(0).max(1).optional(),
  secret: z.coerce.boolean().optional(),
});
export type EpisodeFrontmatter = z.infer<typeof EpisodeFrontmatter>;

// ── Disputes ───────────────────────────────────────────────────────────────────

export const Claim = z.object({
  value: FactValue,
  by: z.string().optional(),
  at: z.string().optional(),
  src: z.array(z.string()).default([]),
  confidence,
});
export type Claim = z.infer<typeof Claim>;

export const DisputeFrontmatter = z.looseObject({
  type: z.literal("dispute"),
  entity: z.string(),
  field: z.string(),
  status: z.enum(["open", "resolved"]).default("open"),
  claims: z.array(Claim).default([]),
  /** Set by the human to settle the dispute; applied on the next sleep. */
  ruling: FactValue.optional(),
  opened: z.string().optional(),
  resolved: z.string().optional(),
});
export type DisputeFrontmatter = z.infer<typeof DisputeFrontmatter>;

// ── Vault config (_hippo/config.yaml) ─────────────────────────────────────────

// ── Schema: entity types, fields and episode kinds ─────────────────────────────
// Definitions come from `_hippo/schema/{types,kinds}/*.md` notes and inline `types:`/`kinds:` in the
// config (see schema-registry.ts). Code checks capabilities, never type names. Everything here is
// optional without defaults, so an inline entry can override a note key by key.

/** Behaviour a type opts into: `goal` (status, owner, progress), `actor` (an agent: lane, authority), `arc` (groups goals). */
export const Capability = z.enum(["goal", "actor", "arc"]);
export type Capability = z.infer<typeof Capability>;

const list = <T extends z.ZodType>(item: T) => z.preprocess((v) => (v == null ? undefined : Array.isArray(v) ? v : [v]), z.array(item).optional());

export const FieldDef = z.preprocess(
  // `email: text` is shorthand for `email: { kind: text }`.
  (v) => (typeof v === "string" ? { kind: v } : v),
  z.looseObject({
    kind: z.enum(["text", "number", "bool", "date", "ref", "enum"]).default("text"),
    many: z.boolean().optional(),
    /** Allowed values of an `enum` field. */
    values: list(z.coerce.string()),
    /** Type(s) a `ref` field points at. */
    target: list(z.string()),
    /** Only the human may set it; anyone else's report becomes a proposal. */
    human_only: z.boolean().optional(),
    /** Always stored encrypted. */
    secret: z.boolean().optional(),
    /** Kept out of search, prompts and summaries; shown only to bound callers with authority. */
    confidential: z.boolean().optional(),
    /** A newer value succeeds the old one (a new employer) instead of disputing it. */
    succession: z.boolean().optional(),
    recurs: z.enum(["yearly"]).optional(),
    /** Identifies one real-world thing (an email, a repo url); implies `confidential`. */
    identity_key: z.boolean().optional(),
    default: FactValue.optional(),
    /** Lane domain whose agents are authoritative for this field. */
    domain: z.string().optional(),
    description: z.string().optional(),
  }),
);
export type FieldDef = z.infer<typeof FieldDef>;

export const TypeDef = z.looseObject({
  folder: opt(z.string()),
  description: opt(z.string()),
  /** Parent type: its fields, capabilities, statuses and template carry over; the child wins. */
  extends: opt(z.string()),
  capabilities: list(Capability),
  /** Entities of this type can be inherited from (archetypes, clients). */
  inheritable: z.boolean().optional(),
  fields: z.record(z.string(), FieldDef).optional(),
  /** Status vocabulary: a list, or words mapped to core states (`won: done`). */
  statuses: z.preprocess(
    (v) => (Array.isArray(v) ? Object.fromEntries(v.map((s) => [String(s), String(s)])) : v),
    z.record(z.string(), z.coerce.string()).optional(),
  ),
  /** Vault path of the note new entities of this type start from. */
  template: opt(z.string()),
  label: opt(z.string()),
  codex_label: opt(z.string()),
  /** Legacy (v1): fields whose values are always secrets. Same as `fields.<name>.secret`. */
  secret_fields: list(z.string()),
});
export type TypeDef = z.infer<typeof TypeDef>;

/** What a kind of episode does in the curator. */
export const Behaviour = z.enum(["observation", "fact", "decision", "question", "task", "interaction"]);
export type Behaviour = z.infer<typeof Behaviour>;

export const KindDef = z.looseObject({
  behaviour: Behaviour.optional(),
  /** Another kind's name: this one is a synonym (`beat` → observation). */
  alias_of: opt(z.string()),
  /** Whether the episode text is required, optional, kept only as a gist, or forbidden. */
  text: z.enum(["required", "optional", "gist", "forbidden"]).optional(),
  gist_max: z.number().int().positive().optional(),
  /** Typed structured data the episode may carry. */
  data: z.record(z.string(), FieldDef).optional(),
  counts_as_contact: z.boolean().optional(),
  reducers: list(z.string()),
  description: opt(z.string()),
});
export type KindDef = z.infer<typeof KindDef>;

/** A person whose word outranks every agent's. Their `domains` rank them above the other humans there. */
export const HumanDef = z.object({
  id: z.coerce.string(),
  domains: stringList.default([]),
  /** GitHub login, so the hosted dashboard knows which human is signed in. */
  github: opt(z.coerce.string()),
});
export type HumanDef = z.infer<typeof HumanDef>;

/** A relation name, optionally with the name of its reverse direction (`depends_on` ↔ `used_by`). */
export const RelationDef = z.union([z.string(), z.object({ name: z.string(), inverse: opt(z.string()) })]);
export type RelationDef = z.infer<typeof RelationDef>;

/** v1 keys under their new names: `campaign` → `name`, `human: x` → `humans: [{ id: x }]`. */
function legacyConfig(v: unknown): unknown {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return v;
  const { campaign, human, ...rest } = v as Record<string, unknown>;
  const out: Record<string, unknown> = { ...rest };
  if (out.name == null && campaign != null) out.name = campaign;
  const humans = Array.isArray(out.humans) ? out.humans.map((h) => (typeof h === "object" && h !== null ? h : { id: h })) : [];
  out.humans = humans.length ? humans : [{ id: human ?? "human" }];
  return out;
}

const ConfigObject = z.object({
  /** Vault format version; see migrations.ts. */
  version: z.number().int().nonnegative().default(1),
  /** What this memory is about. */
  name: z.coerce.string().default("campaign"),
  /** IANA timezone used for chronicle days and times. */
  timezone: z.string().default("UTC"),
  /** People whose word outranks every agent's; the first is the primary human (missing `by` = them). */
  humans: z.array(HumanDef).min(1),
  /** Inline type definitions; they override `_hippo/schema/types/*.md` notes of the same name. */
  types: z.record(z.string(), TypeDef).optional(),
  /** Inline kind definitions; they override `_hippo/schema/kinds/*.md` notes of the same name. */
  kinds: z.record(z.string(), KindDef).optional(),
  relations: z.array(RelationDef).default([]),
  /** Tag vocabulary used for lanes/authority (e.g. residency, housing). */
  domains: z.array(z.string()).default([]),
  folders: z
    .object({
      inbox: z.string().default("inbox"),
      chronicle: z.string().default("chronicle"),
      disputes: z.string().default("disputes"),
      secrets: z.string().default("secrets"),
      /** Type and kind notes (`types/`, `kinds/`); see schema-registry.ts. */
      schema: opt(z.string()),
    })
    .prefault({}),
  curator: z
    .object({
      /** Distinct sources needed to promote a rumor to canon. */
      canon_threshold: z.number().int().positive().default(2),
      batch_size: z.number().int().positive().default(25),
      summaries: z.boolean().default(true),
      /** Days after which a fact is considered stale and flagged for re-verification. */
      stale_after_days: z.number().int().positive().default(60),
    })
    .prefault({}),
  secrets: z
    .object({
      /** age recipient (public key). Encryption needs only this; decryption needs the identity. */
      recipient: opt(z.string()),
    })
    .prefault({}),
});

export const HippoConfig = z.preprocess(
  legacyConfig,
  ConfigObject.transform(({ relations, ...c }) => ({
    ...c,
    /** Relation names (each relation's forward direction). */
    relations: relations.map((r) => (typeof r === "string" ? r : r.name)),
    /** Declared inverse names, by forward name. Adding an inverse is stored as its forward relation. */
    relation_inverses: Object.fromEntries(relations.flatMap((r) => (typeof r !== "string" && r.inverse ? [[r.name, r.inverse]] : []))) as Record<string, string>,
    /** @deprecated v1 name of `name`, kept for display. */
    campaign: c.name,
    /** The primary human's id (`humans[0].id`), kept for display and as the default author. */
    human: c.humans[0]!.id,
  })),
);
export type HippoConfig = z.infer<typeof HippoConfig>;
