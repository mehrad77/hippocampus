import { useMemo } from "react";
import { useResource } from "../../lib/cache.ts";
import { titleCase } from "../../lib/format.ts";
import { href } from "../../lib/routes.ts";
import type { Catalog, FactStatus, Ref } from "../../lib/types.ts";
import { EntityLink, TypeDot } from "../EntityLink.tsx";

const LINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;

/** Agent text with [[wikilinks]] reduced to their labels, for places that are already a link (cards, options). */
export function plainText(text: string): string {
  return text.replace(LINK, (_m, target: string, alias?: string) => (alias ?? target).trim());
}

const TALLY: [FactStatus, string, string][] = [
  ["canon", "✓", "canon"],
  ["rumor", "?", "rumors"],
  ["disputed", "!", "disputed"],
  ["retconned", "✕", "retconned"],
];

/** A card's facts by status as tiny seals (glyph + count, the word in the tooltip and for screen readers). */
export function FactTally({ facts }: { facts: Record<FactStatus, number> }) {
  const shown = TALLY.filter(([s]) => facts[s] > 0);
  if (!shown.length) return <span className="small muted">no facts yet</span>;
  return (
    <span className="tally">
      {shown.map(([s, glyph, word]) => (
        <span key={s} className={`seal seal--${s}`} title={`${facts[s]} ${word}`}>
          <span className="seal__glyph" aria-hidden>
            {glyph}
          </span>
          {facts[s]}
          <span className="sr-only"> {word}</span>
        </span>
      ))}
    </span>
  );
}

/** slug → Ref from the (cached) catalog, so bare slugs from the chronicle get titles and type dots. */
export function useRefs(): Map<string, Ref> {
  const catalog = useResource<Catalog>("/catalog");
  return useMemo(() => new Map((catalog.data?.entities ?? []).map((e) => [e.slug, { slug: e.slug, title: e.title, type: e.type }])), [catalog.data]);
}

/** A slug as a link, dressed with its title and type when the catalog knows it. */
export function SlugLink({ slug, refs, fallbackType = "other" }: { slug: string; refs: Map<string, Ref>; fallbackType?: string }) {
  const ref = refs.get(slug);
  return <EntityLink entity={ref ?? { slug, title: fallbackType === "party" ? titleCase(slug) : slug, type: fallbackType }} />;
}

/**
 * An agent id as a link to its party sheet. Once the catalog has loaded, an agent without a
 * party note (an unknown agent) stays plain text instead of linking to a missing page.
 */
export function AgentLink({ agent, refs }: { agent: string; refs?: Map<string, Ref> }) {
  if (refs?.size && !refs.has(agent)) return <span title="No party note for this agent">{agent}</span>;
  return <SlugLink slug={agent} refs={refs ?? new Map()} fallbackType="party" />;
}

/** "quest" chip with its type dot, linking to the Codex filtered to that type. */
export function TypeLink({ type }: { type: string }) {
  return (
    <a className={`chip typed typed--${type}`} href={href.codex(type)} title={`All ${type} entries`}>
      <TypeDot type={type} />
      {type}
    </a>
  );
}

export function StatusChip({ status }: { status?: string }) {
  if (!status) return null;
  return <span className={`chip status-chip status-chip--${status.replace(/[^\w-]/g, "")}`}>{status}</span>;
}

/** First letter of a title for the type sigil, skipping articles and punctuation. */
export function initial(title: string): string {
  const word = title.replace(/^(the|a|an)\s+/i, "").match(/[\p{L}\p{N}]/u);
  return (word?.[0] ?? "?").toUpperCase();
}
