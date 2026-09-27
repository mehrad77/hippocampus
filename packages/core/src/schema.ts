import { z } from "zod";

/** Optional field that also accepts YAML null / empty string (common in hand-written notes and templates). */
const opt = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === null || v === "" ? undefined : v), schema.optional());

// ── Facts ──────────────────────────────────────────────────────────────────────

export const FactValue = z.union([z.string(), z.number(), z.boolean()]);
export type FactValue = z.infer<typeof FactValue>;

/** rumor → unverified; canon → accepted truth; disputed → awaiting a ruling; retconned → superseded. */
export const FactStatus = z.enum(["rumor", "canon", "disputed", "retconned"]);
export type FactStatus = z.infer<typeof FactStatus>;

export const PriorValue = z.object({
  value: FactValue,
  by: z.string().optional(),
  at: z.string().optional(),
});

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

export const TypeDef = z.object({
  folder: z.string(),
  description: z.string().default(""),
  /** Fields whose values are always stored as secrets. */
  secret_fields: z.array(z.string()).default([]),
});

export const HippoConfig = z.object({
  /** Vault format version; see migrations.ts. */
  version: z.number().int().nonnegative().default(1),
  campaign: z.string().default("campaign"),
  /** IANA timezone used for chronicle days and times. */
  timezone: z.string().default("UTC"),
  /** Party id that represents the human; their word outranks everyone. */
  human: z.string().default("human"),
  types: z.record(z.string(), TypeDef),
  relations: z.array(z.string()).default([]),
  /** Tag vocabulary used for lanes/authority (e.g. residency, housing). */
  domains: z.array(z.string()).default([]),
  folders: z
    .object({
      inbox: z.string().default("inbox"),
      chronicle: z.string().default("chronicle"),
      disputes: z.string().default("disputes"),
      secrets: z.string().default("secrets"),
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
export type HippoConfig = z.infer<typeof HippoConfig>;

export const SYSTEM_TYPES = ["party", "quest", "campaign"] as const;
