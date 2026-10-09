// The two voices of the dashboard. Plain (the default) uses everyday words; the codex keeps the
// tabletop vocabulary. Static pages render both and CSS shows one (`.lbl-plain` / `.lbl-codex`);
// islands call `useTerms()` (prefs.ts) and pick one.

export type Look = "plain" | "codex";

export const TERMS = {
  // Pages
  tavern: ["Home", "Tavern"],
  quests: ["Goals", "Quest board"],
  council: ["Disputes", "Council"],
  satchel: ["Inbox", "Satchel"],
  codex: ["Records", "Codex"],
  map: ["Connections", "Map"],
  chronicle: ["Timeline", "Chronicle"],
  party: ["Agents", "Party"],
  guides: ["Help", "Guides"],
  setup: ["Setup & health", "Setup & health"],
  sessionZero: ["Setup", "Session Zero"],
  handbook: ["Help & guides", "The Player's Handbook"],
  // Nav sections
  navPlay: ["Work", "At the table"],
  navLore: ["Knowledge", "Lore"],
  // Things
  quest: ["goal", "quest"],
  questPlural: ["goals", "quests"],
  dispute: ["dispute", "dispute"],
  agent: ["agent", "party member"],
  entity: ["record", "entry"],
  episode: ["note", "episode"],
  sleep: ["nightly update", "sleep"],
  human: ["you", "the player"],
  // Actions
  scribe: ["Add a note", "Scribe a memory"],
  search: ["Search", "Search"],
  // Fact statuses
  canon: ["Confirmed", "canon"],
  rumor: ["Unverified", "rumor"],
  disputed: ["Disputed", "disputed"],
  retconned: ["Replaced", "retconned"],
} as const satisfies Record<string, readonly [plain: string, codex: string]>;

export type TermKey = keyof typeof TERMS;

export function term(key: TermKey, look: Look): string {
  return TERMS[key][look === "codex" ? 1 : 0];
}

// Everyday names for the built-in entity types and episode kinds. Display only: filters, URLs and
// CSS classes keep the vault's own names, and types a vault adds show as they are.
const PLAIN_TYPES: Record<string, string> = {
  quest: "goal",
  party: "agent",
  campaign: "project",
  character: "person",
  faction: "organization",
  location: "place",
  lore: "reference",
};
const PLAIN_KINDS: Record<string, string> = { beat: "milestone" };

export function typeLabel(type: string, plain: boolean): string {
  return plain ? (PLAIN_TYPES[type] ?? type) : type;
}

export function kindLabel(kind: string, plain: boolean): string {
  return plain ? (PLAIN_KINDS[kind] ?? kind) : kind;
}
