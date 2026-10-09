import { href } from "../lib/routes.ts";
import type { Ref } from "../lib/types.ts";

export function TypeDot({ type }: { type: string }) {
  return <span className={`dot typed typed--${type}`} aria-hidden />;
}

/** A link to an entity sheet, with its type's colored dot (the type is also in the tooltip). */
export function EntityLink({ entity, children }: { entity: Pick<Ref, "slug" | "title" | "type">; children?: React.ReactNode }) {
  return (
    <a className="elink" href={href.entity(entity.slug)} title={`${entity.title} · ${entity.type}`}>
      <TypeDot type={entity.type} />
      {children ?? entity.title}
    </a>
  );
}

export function TypeBadge({ type }: { type: string }) {
  return (
    <span className={`chip typed typed--${type}`}>
      <TypeDot type={type} />
      {type}
    </span>
  );
}
