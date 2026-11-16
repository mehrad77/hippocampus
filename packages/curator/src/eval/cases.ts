// The curator eval's cases: small nights on the fictional relocation vault (seeds/example-relocation),
// each with what a careful curator would do. Names and values are made up; never use a real vault's.

/** One memory in a case's inbox. */
export interface CaseEpisode {
  agent: string;
  at: string;
  text: string;
  secret?: boolean;
  confidential?: boolean;
}

export interface Gold {
  /** Things the episodes name, by any accepted spelling, and their type. */
  mentions: { name: string[]; type: string }[];
  /** What each named thing should resolve to: an existing note's slug, or "new". Keyed by its first name. */
  resolves?: Record<string, string>;
  /** Facts canon should hold afterwards. `field` is the vault's own field; `also` are names a curator may reasonably pick instead. */
  facts: { entity: string; field: string; also?: string[]; value: string; secret?: boolean }[];
  /** `entity.field` that must not be disputed after the night. */
  noDispute?: string[];
  /** Names that must not become notes (an ID number, a passing state). */
  noEntity?: string[];
  /** Values that must never appear in plain text outside the inbox: secrets, confidential details. */
  hidden?: string[];
  /** Goal objectives the night should tick. */
  ticks?: { goal: string; objective: string }[];
}

export interface EvalCase {
  id: string;
  family: "annotation" | "match" | "fields" | "normalize" | "secret" | "goal" | "rules";
  /** What it checks, in one line. */
  about: string;
  /** Notes added to the seed vault before the night (path → file). */
  notes?: Record<string, string>;
  episodes: CaseEpisode[];
  gold: Gold;
}

const note = (type: string, title: string, facts: Record<string, string>, extra = "") =>
  `---\ntype: ${type}\ntitle: "${title}"\n${extra}facts:\n${Object.entries(facts)
    .map(([k, v]) => `  ${k}: { value: "${v}", status: canon, by: residency-agent, src: [ep-seed] }`)
    .join("\n")}\n---\n`;

export const CASES: readonly EvalCase[] = [
  {
    id: "annotation-date",
    family: "annotation",
    about: "A confirmed date with a note in brackets corroborates the canon date; it opens no dispute.",
    notes: { "factions/migration-agency.md": note("faction", "Migration Agency", { appointment_date: "2026-03-14" }, "aliases: [Agência de Migração, the agency]\ntags: [residency]\n") },
    episodes: [{ agent: "home-finder", at: "2026-03-01T10:00:00Z", text: "The migration agency appointment is 2026-03-14 (confirmed by phone)." }],
    gold: {
      mentions: [{ name: ["Migration Agency", "migration agency", "Agência de Migração"], type: "faction" }],
      resolves: { "Migration Agency": "migration-agency" },
      facts: [{ entity: "migration-agency", field: "appointment_date", value: "2026-03-14" }],
      noDispute: ["migration-agency.appointment_date"],
    },
  },
  {
    id: "annotation-address",
    family: "annotation",
    about: "An address with and without a floor note is the same address.",
    notes: { "locations/alfama-flat.md": note("location", "Alfama flat", { address: "Rua das Flores 12, Lisbon" }) },
    episodes: [{ agent: "home-finder", at: "2026-03-02T09:00:00Z", text: "The Alfama flat is at Rua das Flores 12, Lisbon (2nd floor, left)." }],
    gold: {
      mentions: [{ name: ["Alfama flat"], type: "location" }],
      resolves: { "Alfama flat": "alfama-flat" },
      facts: [{ entity: "alfama-flat", field: "address", value: "Rua das Flores 12, Lisbon" }],
      noDispute: ["alfama-flat.address"],
    },
  },
  {
    id: "match-trap-branch",
    family: "match",
    about: "A second office with a similar name is a new note, not the agency.",
    episodes: [{ agent: "residency-agent", at: "2026-03-03T11:00:00Z", text: "The Porto Migration Office, a separate branch in Porto, opens at 09:00 on weekdays." }],
    gold: {
      mentions: [{ name: ["Porto Migration Office"], type: "faction" }],
      resolves: { "Porto Migration Office": "new" },
      facts: [{ entity: "porto-migration-office", field: "opening_hours", also: ["hours", "opens"], value: "09:00 on weekdays" }],
      noDispute: ["migration-agency.opening_hours"],
    },
  },
  {
    id: "match-alias",
    family: "match",
    about: "A known alias resolves to the existing note.",
    episodes: [{ agent: "campus-agent", at: "2026-03-04T12:00:00Z", text: "HU's international office is in Building C." }],
    gold: {
      mentions: [{ name: ["HU", "Harbor University"], type: "faction" }],
      resolves: { HU: "harbor-university" },
      facts: [{ entity: "harbor-university", field: "international_office", also: ["international_office_location", "international_office_building"], value: "Building C" }],
    },
  },
  {
    id: "field-reuse",
    family: "fields",
    about: "A new value for an existing field reuses its name instead of a synonym.",
    notes: { "characters/case-officer.md": note("character", "Case Officer", { phone: "+351 900 000 010" }) },
    episodes: [{ agent: "residency-agent", at: "2026-03-05T08:00:00Z", text: "The case officer's telephone number is now +351 900 000 011." }],
    gold: {
      mentions: [{ name: ["Case Officer", "case officer"], type: "character" }],
      resolves: { "Case Officer": "case-officer" },
      facts: [{ entity: "case-officer", field: "phone", value: "+351 900 000 011" }],
    },
  },
  {
    id: "normalize-money-date",
    family: "normalize",
    about: "Amounts carry their currency, and a relative date becomes an ISO date.",
    episodes: [{ agent: "home-finder", at: "2026-03-06T10:00:00Z", text: "The Graça studio rents for 950 euros a month, available from tomorrow." }],
    gold: {
      mentions: [{ name: ["Graça studio"], type: "location" }],
      resolves: { "Graça studio": "new" },
      facts: [
        { entity: "graca-studio", field: "rent", also: ["monthly_rent", "price"], value: "950 EUR" },
        { entity: "graca-studio", field: "available_from", also: ["availability", "available"], value: "2026-03-07" },
      ],
    },
  },
  {
    id: "secret-passport",
    family: "secret",
    about: "An ID number is a secret fact, never a note, never in plain text.",
    episodes: [{ agent: "residency-agent", at: "2026-03-07T10:00:00Z", text: "The player's passport number is X98765432, needed for the agency.", secret: true }],
    gold: {
      mentions: [{ name: ["Passport", "passport"], type: "item" }],
      facts: [{ entity: "passport", field: "number", also: ["passport_number"], value: "X98765432", secret: true }],
      noEntity: ["X98765432"],
      hidden: ["X98765432"],
    },
  },
  {
    id: "confidential-health",
    family: "secret",
    about: "A confidential memory's details stay out of summaries and names.",
    episodes: [{ agent: "residency-agent", at: "2026-03-08T10:00:00Z", text: "The player's health insurance at Lisbon Care covers a knee therapy plan.", confidential: true }],
    gold: {
      mentions: [{ name: ["Lisbon Care"], type: "faction" }],
      facts: [],
      hidden: ["knee therapy"],
    },
  },
  {
    id: "goal-progress",
    family: "goal",
    about: "Booking the appointment ticks the goal's objective.",
    episodes: [{ agent: "residency-agent", at: "2026-03-09T10:00:00Z", text: "Booked the agency appointment for the residence permit: 2026-04-02 at 10:30." }],
    gold: {
      mentions: [{ name: ["Migration Agency", "agency", "the agency"], type: "faction" }],
      resolves: { "Migration Agency": "migration-agency" },
      facts: [{ entity: "migration-agency", field: "appointment_date", also: ["appointment"], value: "2026-04-02T10:30" }],
      ticks: [{ goal: "residence-permit", objective: "Agency appointment" }],
    },
  },
];
