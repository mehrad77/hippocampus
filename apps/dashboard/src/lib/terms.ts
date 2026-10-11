// The two voices of the dashboard. Plain (the default) uses everyday words; the codex keeps the
// tabletop vocabulary. Static pages render both and CSS shows one (`.lbl-plain` / `.lbl-codex`);
// islands call `useTerms()` (prefs.ts) and pick one.

export type Look = "plain" | "codex";

export const TERMS = {
  // Pages
  tavern: ["Home", "Tavern"],
  goals: ["Goals", "Quest board"],
  /** @deprecated Same as `goals`. */
  quests: ["Goals", "Quest board"],
  council: ["Disputes", "Council"],
  satchel: ["Inbox", "Satchel"],
  codex: ["Records", "Codex"],
  map: ["Connections", "Map"],
  chronicle: ["Timeline", "Chronicle"],
  party: ["Agents", "Party"],
  guides: ["Help", "Guides"],
  setup: ["Setup & health", "Setup & health"],
  admin: ["Admin", "Admin"],
  welcome: ["Welcome", "Welcome"],
  privacy: ["Privacy", "Privacy"],
  sessionZero: ["Setup", "Session Zero"],
  handbook: ["Help & guides", "The Player's Handbook"],
  // Nav sections
  navPlay: ["Work", "At the table"],
  navLore: ["Knowledge", "Lore"],
  // Things
  goal: ["goal", "quest"],
  goalPlural: ["goals", "quests"],
  /** @deprecated Same as `goal`. */
  quest: ["goal", "quest"],
  /** @deprecated Same as `goalPlural`. */
  questPlural: ["goals", "quests"],
  human: ["you", "the player"],
  humans: ["people", "players"],
  proposal: ["suggestion", "petition"],
  confidential: ["confidential", "sealed from the table"],
  dispute: ["dispute", "dispute"],
  agent: ["agent", "party member"],
  entity: ["record", "entry"],
  episode: ["note", "episode"],
  sleep: ["nightly update", "sleep"],
  // Actions
  scribe: ["Add a note", "Scribe a memory"],
  search: ["Search", "Search"],
  approve: ["Approve", "Seat at the table"],
  dismiss: ["Dismiss", "Turn away"],
  // Agents asking to join (`introduce`)
  introductions: ["Agents asking to join", "At the door"],
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

// Type names come from the vault's type notes (`label`, `codex_label`); these cover vaults whose
// notes don't say, and v1 names. Display only: filters, URLs and CSS classes keep the vault's own names.
const PLAIN_TYPES: Record<string, string> = {
  quest: "goal",
  party: "agent",
  campaign: "project",
  arc: "arc",
  character: "person",
  faction: "organization",
  location: "place",
  lore: "topic",
  item: "thing",
};

/** What the dashboard knows about a type's names (a catalog or overview `TypeView`). */
export interface TypeNames {
  name: string;
  label?: string;
  codexLabel?: string;
}

// The last type names a page loaded (catalog or overview), so links drawn without them still read right.
const known = new Map<string, TypeNames>();

/** Remember the vault's type names for `typeLabel` calls that don't pass them. */
export function rememberTypeNames(types: readonly TypeNames[] | undefined): void {
  for (const t of types ?? []) known.set(t.name, t);
}

/** A type in the reader's voice: the type note's `label` (plain) or `codex_label` (codex), else a fallback. */
export function typeLabel(type: string, plain: boolean, types?: readonly TypeNames[]): string {
  const t = types?.find((x) => x.name === type) ?? known.get(type);
  if (plain) return t?.label ?? PLAIN_TYPES[type] ?? type;
  return t?.codexLabel ?? type;
}
