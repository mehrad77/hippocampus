import type { CollectionEntry } from "astro:content";

export type Section = CollectionEntry<"guides">["data"]["section"];

/**
 * The guide sections in both voices. The frontmatter keeps the codex name (it is the content
 * collection's enum and the anchor id); pages show the plain name unless the codex look is on.
 */
export const SECTIONS: { name: Section; plain: string; blurb: readonly [plain: string, codex: string] }[] = [
  { name: "Basics", plain: "Basics", blurb: ["What Hippocampus is, and the rules every fact follows.", "What Hippocampus is, and the rules every fact plays by."] },
  { name: "The table", plain: "Goals, agents and secrets", blurb: ["Goals, your agents and what each one handles, and the secrets you keep.", "Quests, the party and its lanes, and the secrets you keep."] },
  { name: "Running it", plain: "Running it", blurb: ["Connecting agents, the nightly update, and the dashboard.", "Connecting agents, the nightly sleep, and the dashboard."] },
  { name: "Under the hood", plain: "Under the hood", blurb: ["The command line, and how your memory stays yours.", "The command line, and how your memory stays yours."] },
];

/** A section's plain name (its codex name is the frontmatter value itself). */
export function plainSection(name: string): string {
  return SECTIONS.find((s) => s.name === name)?.plain ?? name;
}
