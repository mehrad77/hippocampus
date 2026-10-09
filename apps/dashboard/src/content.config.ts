import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";
import { ICONS, type IconName } from "./lib/icons.ts";

// The guides ship inside the dashboard build, so they always describe the version you run.
// Flat files only: the privacy guard rejects any `inbox/`, `chronicle/` or `disputes/` directory.
const guides = defineCollection({
  loader: glob({ pattern: "*.mdx", base: "./src/content/guides" }),
  schema: z.object({
    title: z.string(),
    summary: z.string(),
    /** Reading order across all sections; prev/next follow it. */
    order: z.number(),
    section: z.enum(["Basics", "The table", "Running it", "Under the hood"]),
    /** An icon from `lib/icons.ts`, shown on the guide's card. */
    sigil: z.enum(Object.keys(ICONS) as [IconName, ...IconName[]]),
  }),
});

export const collections = { guides };
