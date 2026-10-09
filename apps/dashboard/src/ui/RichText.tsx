import { Fragment } from "react";
import { href } from "../lib/routes.ts";

const LINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;

/**
 * Agent-written text (episodes, chronicle, summaries) as plain text with [[wikilinks]] made
 * clickable. No markdown or HTML is interpreted: it came from a model, not from you.
 */
export function RichText({ text, className }: { text: string; className?: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    if (m.index! > last) parts.push(text.slice(last, m.index));
    const target = m[1]!.trim();
    parts.push(
      <a key={m.index} className="wikilink" href={href.entity(target)}>
        {m[2]?.trim() || target}
      </a>,
    );
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return (
    <span className={`pre-line${className ? ` ${className}` : ""}`}>
      {parts.map((p, i) => (
        <Fragment key={i}>{p}</Fragment>
      ))}
    </span>
  );
}
