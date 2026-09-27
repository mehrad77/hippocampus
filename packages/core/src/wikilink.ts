export interface WikiLink {
  target: string;
  heading?: string;
  alias?: string;
}

const LINK_RE = /\[\[([^\]|#]*)(?:#([^\]|]*))?(?:\|([^\]]*))?\]\]/g;

export function parseLinks(text: string): WikiLink[] {
  const out: WikiLink[] = [];
  for (const m of text.matchAll(LINK_RE)) {
    out.push({
      target: (m[1] ?? "").trim(),
      heading: m[2]?.trim() || undefined,
      alias: m[3]?.trim() || undefined,
    });
  }
  return out;
}

/** If `ref` is a single wikilink, return its target; otherwise return ref trimmed. */
export function unwrapLink(ref: string): string {
  const trimmed = ref.trim();
  const m = /^\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/.exec(trimmed);
  return (m ? (m[1] ?? "") : trimmed).trim().replace(/\.md$/, "");
}

export function link(target: string, alias?: string): string {
  return alias && alias !== target ? `[[${target}|${alias}]]` : `[[${target}]]`;
}
