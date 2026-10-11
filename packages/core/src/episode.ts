import { parseDoc, renderDoc } from "./markdown.ts";
import { EpisodeFrontmatter, type EpisodeData, type EpisodeKind } from "./schema.ts";
import { hash, slugify, ulid } from "./text.ts";

/** A raw memory submitted by an agent, waiting in the inbox for consolidation. */
export interface Episode {
  id: string;
  path: string;
  agent: string;
  /** As written; `vault.schema.kind()` resolves it (an unknown kind is an observation). */
  kind: EpisodeKind;
  at: string;
  about: string[];
  confidence?: number;
  secret?: boolean;
  /** Kept out of search, prompts and the chronicle. */
  confidential?: boolean;
  /** Context the memory holds in, like a fact's `@scope`. */
  scope?: string;
  /** Typed structured data (see the kind's `data:` fields). */
  data?: EpisodeData;
  /** Empty for kinds whose text is optional or forbidden. */
  text: string;
}

export function parseEpisode(path: string, raw: string, inboxFolder: string, fallbackAt: string): Episode {
  const { data, body } = parseDoc(raw);
  const fm = EpisodeFrontmatter.parse(data);
  const rel = path.startsWith(`${inboxFolder}/`) ? path.slice(inboxFolder.length + 1) : path;
  const agentFromPath = rel.includes("/") ? rel.split("/")[0] : undefined;
  return {
    id: fm.id ?? `ep-${hash(path)}`,
    path,
    agent: (fm.agent ?? agentFromPath ?? "unknown").toLowerCase(),
    kind: fm.kind.trim() || "observation",
    at: normalizeAt(fm.at) ?? fallbackAt,
    about: fm.about,
    confidence: fm.confidence,
    secret: fm.secret,
    ...(fm.confidential ? { confidential: true } : {}),
    ...(fm.scope ? { scope: fm.scope } : {}),
    ...(fm.data && Object.keys(fm.data).length ? { data: fm.data } : {}),
    text: body.trim(),
  };
}

function normalizeAt(at: string | undefined): string | undefined {
  if (!at) return undefined;
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export interface NewEpisode {
  agent: string;
  /** Required unless the kind makes it optional or forbids it (see kinds.ts). */
  text?: string;
  kind?: EpisodeKind;
  about?: string[];
  confidence?: number;
  secret?: boolean;
  confidential?: boolean;
  scope?: string;
  data?: EpisodeData;
  at?: string;
}

export function createEpisode(inboxFolder: string, input: NewEpisode, now = new Date()): Episode {
  const id = `ep-${ulid(now.getTime())}`;
  const at = normalizeAt(input.at) ?? now.toISOString();
  const agent = slugify(input.agent);
  const stamp = at.slice(0, 19).replace(/:/g, "");
  return {
    id,
    path: `${inboxFolder}/${agent}/${stamp}-${id.slice(-6).toLowerCase()}.md`,
    agent,
    kind: input.kind ?? "observation",
    at,
    about: input.about ?? [],
    confidence: input.confidence,
    secret: input.secret,
    ...(input.confidential ? { confidential: true } : {}),
    ...(input.scope?.trim() ? { scope: input.scope.trim() } : {}),
    ...(input.data && Object.keys(input.data).length ? { data: input.data } : {}),
    text: (input.text ?? "").trim(),
  };
}

export function renderEpisode(ep: Episode): string {
  return renderDoc(
    {
      id: ep.id,
      agent: ep.agent,
      kind: ep.kind,
      at: ep.at,
      about: ep.about.length ? ep.about : undefined,
      confidence: ep.confidence,
      secret: ep.secret || undefined,
      confidential: ep.confidential || undefined,
      scope: ep.scope || undefined,
      data: ep.data && Object.keys(ep.data).length ? ep.data : undefined,
    },
    ep.text ? `${ep.text}\n` : "",
  );
}
