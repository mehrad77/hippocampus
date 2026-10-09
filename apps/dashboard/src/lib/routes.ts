// Links that respect Astro's `base` (/dashboard), so the same build works under the CLI and the Worker.
export const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
export const API = `${BASE}/api`;
/** Sign-in and sign-out on the Worker (GitHub), next to the API rather than under it. */
export const AUTH = `${BASE}/auth`;

export type Page = "tavern" | "quests" | "council" | "codex" | "map" | "chronicle" | "satchel" | "party" | "guides" | "setup" | "admin" | "welcome" | "privacy";

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
  admin: "/admin/",
  welcome: "/welcome/",
  privacy: "/privacy/",
};

export const href = {
  page: (p: Page, hash = "") => `${BASE}${PATHS[p]}${hash}`,
  entity: (slug: string) => `${BASE}/entity/?ref=${encodeURIComponent(slug)}`,
  guide: (slug: string) => `${BASE}/guides/${slug}/`,
  chronicle: (month?: string, id?: string) => `${BASE}/chronicle/${month ? `?month=${month}` : ""}${id ? `#${id}` : ""}`,
  codex: (type?: string) => `${BASE}/codex/${type ? `?type=${encodeURIComponent(type)}` : ""}`,
  map: (focus?: string) => `${BASE}/map/${focus ? `?focus=${encodeURIComponent(focus)}` : ""}`,
  /** GitHub sign-in on the Worker, coming back to `back` (a dashboard path). */
  login: (back = `${BASE}/setup/`) => `${AUTH}/login?return=${encodeURIComponent(back)}`,
  /** A repo on GitHub. */
  github: (repo: string) => `https://github.com/${repo.split("/").map(encodeURIComponent).join("/")}`,
  /** A repo's commit history on GitHub (a branch's, when given). */
  githubCommits: (repo: string, branch?: string) => `https://github.com/${repo.split("/").map(encodeURIComponent).join("/")}/commits${branch ? `/${encodeURIComponent(branch)}` : ""}`,
};

export function param(name: string): string | null {
  return typeof location === "undefined" ? null : new URLSearchParams(location.search).get(name);
}
