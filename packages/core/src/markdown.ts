import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface ParsedDoc {
  data: Record<string, unknown>;
  body: string;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseDoc(raw: string): ParsedDoc {
  const m = FM_RE.exec(raw);
  if (!m) return { data: {}, body: raw };
  const parsed = parseYaml(m[1] ?? "") as unknown;
  const data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  return { data, body: raw.slice(m[0].length) };
}

export function renderDoc(data: Record<string, unknown>, body: string): string {
  const clean = dropUndefined(data);
  const yaml = stringifyYaml(clean, { lineWidth: 0, flowCollectionPadding: false }).trimEnd();
  const trimmedBody = body.replace(/^\n+/, "");
  return `---\n${yaml}\n---\n${trimmedBody.endsWith("\n") || trimmedBody === "" ? trimmedBody : `${trimmedBody}\n`}`;
}

function dropUndefined(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
  return out;
}

// ── Managed regions ────────────────────────────────────────────────────────────
// Regions are delimited by Obsidian comments so the markers are invisible in reading view:
//   %% hippo:begin facts %%
//   ...
//   %% hippo:end facts %%
// Everything outside regions is human-owned and never rewritten.

const regionRe = (name: string) =>
  new RegExp(`%% hippo:begin ${name} %%\\n([\\s\\S]*?)\\n?%% hippo:end ${name} %%`);

export function getRegion(body: string, name: string): string | undefined {
  const m = regionRe(name).exec(body);
  return m ? (m[1] ?? "") : undefined;
}

/**
 * Replace a region's content, or insert it. New regions go after the last existing region,
 * or at the top of the body when there are none, so human prose stays below.
 */
export function setRegion(body: string, name: string, content: string): string {
  const block = `%% hippo:begin ${name} %%\n${content.replace(/\n+$/, "")}\n%% hippo:end ${name} %%`;
  const re = regionRe(name);
  if (re.test(body)) return body.replace(re, () => block);
  const ends = [...body.matchAll(/%% hippo:end [\w-]+ %%/g)];
  const last = ends.at(-1);
  if (last && last.index !== undefined) {
    const at = last.index + last[0].length;
    return `${body.slice(0, at)}\n\n${block}${body.slice(at)}`;
  }
  const rest = body.replace(/^\n+/, "");
  return rest ? `${block}\n\n${rest}` : `${block}\n`;
}

export function removeRegion(body: string, name: string): string {
  return body.replace(new RegExp(`\\n*%% hippo:begin ${name} %%[\\s\\S]*?%% hippo:end ${name} %%\\n?`), "\n");
}

/** Body text with all managed regions stripped (the human-owned prose). */
export function humanText(body: string): string {
  return body.replace(/%% hippo:begin ([\w-]+) %%[\s\S]*?%% hippo:end \1 %%/g, "").trim();
}

// ── Checklists (quest objectives) ─────────────────────────────────────────────

export interface ChecklistItem {
  text: string;
  done: boolean;
}

export function parseChecklist(text: string): ChecklistItem[] {
  const out: ChecklistItem[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*[-*] \[( |x|X)\] (.+)$/.exec(line);
    if (m) out.push({ done: m[1] !== " ", text: (m[2] ?? "").trim() });
  }
  return out;
}

export function renderChecklist(items: ChecklistItem[]): string {
  return items.map((i) => `- [${i.done ? "x" : " "}] ${i.text}`).join("\n");
}
