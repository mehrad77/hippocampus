import { z } from "zod";
import type { Entity } from "./entity.ts";

// Agent behaviour (the `actor` capability) lives in code: what an agent handles and where its word
// is authoritative. Parsed on demand from the note's loose frontmatter, like goal props.

const opt = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === null || v === "" ? undefined : v), schema.optional());

export const ActorProps = z.looseObject({
  /** What the agent handles, in a sentence. */
  lane: opt(z.coerce.string()),
  /** Domains where its word is canon at once. */
  authority: z.preprocess((v) => (v == null ? [] : Array.isArray(v) ? v : [v]), z.array(z.coerce.string())).catch([]),
  /** Where it runs (`Claude Desktop`). */
  host: opt(z.coerce.string()),
});
export type ActorProps = z.infer<typeof ActorProps>;

/** Frontmatter keys actor behaviour owns. */
export const ACTOR_KEYS = ["lane", "authority", "host"] as const;

export function actorProps(e: Pick<Entity, "fm">): ActorProps {
  const parsed = ActorProps.safeParse(e.fm);
  return parsed.success ? parsed.data : { authority: [] };
}
