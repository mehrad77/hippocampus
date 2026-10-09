import { z } from "zod";
import { parseDoc, renderDoc } from "./markdown.ts";
import { ulid } from "./text.ts";

// An agent asking to join the party: `inbox/<agent>/_introduction-<ulid>.md`. The `_` prefix keeps it
// out of the episode loader, so tools that predate introductions ignore it and no format bump is needed.

export const INTRODUCTION_PREFIX = "_introduction-";

/** Field limits: an introduction is a few lines the human reads before approving. */
export const INTRODUCTION_LIMITS = { title: 120, lane: 500, host: 120, model: 120, about: 2000 } as const;

const optText = z.preprocess((v) => (v == null || v === "" ? undefined : v), z.coerce.string().optional());

export const IntroductionFrontmatter = z.looseObject({
  type: z.literal("introduction"),
  agent: z.string().min(1),
  title: z.coerce.string().min(1),
  lane: optText,
  host: optText,
  model: optText,
  at: z.coerce.string(),
});

export interface Introduction {
  agent: string;
  path: string;
  title: string;
  lane?: string;
  host?: string;
  model?: string;
  at: string;
  /** What the agent says it does, in its own words. */
  about?: string;
}

export interface NewIntroduction {
  title: string;
  lane?: string;
  host?: string;
  model?: string;
  about?: string;
}

export function isIntroductionPath(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  return name.startsWith(INTRODUCTION_PREFIX) && name.endsWith(".md");
}

/** The agent folder must match the frontmatter, or one agent could introduce another. */
export function parseIntroduction(path: string, raw: string, inboxFolder: string): Introduction {
  const { data, body } = parseDoc(raw);
  const fm = IntroductionFrontmatter.parse(data);
  const folder = path.startsWith(`${inboxFolder}/`) ? path.slice(inboxFolder.length + 1).split("/")[0] : undefined;
  if (fm.agent !== folder) throw new Error(`agent "${fm.agent}" doesn't match its folder`);
  const about = body.trim();
  return { agent: fm.agent, path, title: fm.title, lane: fm.lane, host: fm.host, model: fm.model, at: fm.at, about: about || undefined };
}

const oneLine = (s: string | undefined) => s?.replace(/\s+/g, " ").trim() || undefined;

/** A new introduction for `agent` (an id already checked by `assertAgentId`). */
export function createIntroduction(inboxFolder: string, agent: string, input: NewIntroduction, now = new Date()): Introduction {
  return {
    agent,
    path: `${inboxFolder}/${agent}/${INTRODUCTION_PREFIX}${ulid(now.getTime()).toLowerCase()}.md`,
    title: oneLine(input.title) ?? agent,
    lane: oneLine(input.lane),
    host: oneLine(input.host),
    model: oneLine(input.model),
    at: now.toISOString(),
    about: input.about?.trim() || undefined,
  };
}

export function renderIntroduction(i: Introduction): string {
  return renderDoc({ type: "introduction", agent: i.agent, title: i.title, lane: i.lane, host: i.host, model: i.model, at: i.at }, i.about ? `${i.about}\n` : "");
}
