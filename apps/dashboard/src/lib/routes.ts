// Links that respect Astro's `base` (/dashboard), so the same build works under the CLI and the Worker.
export const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
export const API = `${BASE}/api`;

export type Page = "tavern" | "quests" | "council" | "codex" | "map" | "chronicle" | "satchel" | "party" | "guides" | "setup";

const PATHS: Record<Page, string> = {
  tavern: "/",
  quests: "/quests/",
  council: "/council/",
  codex: "/codex/",
  map: "/map/",
  chronicle: "/chronicle/",
  satchel: "/satchel/",
  party: "/party/",
  guides: "/guides/",
  setup: "/setup/",
};

export const href = {
  page: (p: Page, hash = "") => `${BASE}${PATHS[p]}${hash}`,
  entity: (slug: string) => `${BASE}/entity/?ref=${encodeURIComponent(slug)}`,
  guide: (slug: string) => `${BASE}/guides/${slug}/`,
  chronicle: (month?: string, id?: string) => `${BASE}/chronicle/${month ? `?month=${month}` : ""}${id ? `#${id}` : ""}`,
  codex: (type?: string) => `${BASE}/codex/${type ? `?type=${encodeURIComponent(type)}` : ""}`,
  map: (focus?: string) => `${BASE}/map/${focus ? `?focus=${encodeURIComponent(focus)}` : ""}`,
};

export function param(name: string): string | null {
  return typeof location === "undefined" ? null : new URLSearchParams(location.search).get(name);
}
