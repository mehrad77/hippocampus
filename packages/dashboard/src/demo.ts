import {
  HANDBOOK_PATH,
  MemoryStore,
  REVIEW_PATH,
  Vault,
  addRelation,
  applyFact,
  applyQuestUpdate,
  applyRuling,
  createEpisode,
  generateKeyPair,
  renderDoc,
  renderHandbook,
  type Entity,
  type EpisodeKind,
  type QuestUpdate,
  type VaultStore,
} from "@hippocampus/core";

// The demo campaign: the fictional `example-relocation` seed plus three weeks of party activity,
// replayed through the same ops the curator uses. It lives only in memory (never as vault files in
// this repo), so screenshots, `astro dev` and tests get a lively vault without any real data.

type Fact = [entity: string, field: string, value: string, secret?: boolean];

interface Step {
  /** Days before now (fractions allowed), and the local time of day. */
  ago: number;
  at: string;
  agent: string;
  kind: EpisodeKind;
  text: string;
  create?: { type: string; title: string; slug: string; tags?: string[]; aliases?: string[] }[];
  facts?: Fact[];
  rel?: [from: string, rel: string, to: string][];
  quest?: [quest: string, update: QuestUpdate][];
  secret?: boolean;
}

/** Consolidated history, oldest first. Dates inside facts are relative to now so deadlines stay ahead. */
function script(on: (days: number) => string): Step[] {
  return [
    { ago: 80, at: "10:05", agent: "campus-agent", kind: "fact", text: "The registrar answers at registrar@harbor-university.example.", facts: [["harbor-university", "registrar_email", "registrar@harbor-university.example"]] },
    { ago: 76, at: "16:20", agent: "residency-agent", kind: "fact", text: "The Migration Agency phone line is +351 210 000 000, weekdays 9–16.", facts: [["migration-agency", "phone", "+351 210 000 000"]] },
    { ago: 21, at: "09:12", agent: "game-master", kind: "beat", text: "Chapter II opens: the paperwork gauntlet. Four quests, one deadline that matters." },
    {
      ago: 20,
      at: "11:40",
      agent: "residency-agent",
      kind: "fact",
      text: "Booked the residence-permit appointment at the Migration Agency.",
      facts: [["migration-agency", "appointment_date", on(12)]],
      quest: [["residence-permit", { deadline: on(45), clock: { name: "Paperwork", segments: 6, filled: 1, deadline: on(18) } }]],
    },
    {
      ago: 19,
      at: "14:03",
      agent: "residency-agent",
      kind: "fact",
      text: "Passport scanned for the online application. Number recorded as a secret.",
      secret: true,
      create: [{ type: "item", title: "Passport", slug: "passport", tags: ["residency"] }],
      facts: [
        ["passport", "number", "X0000000", true],
        ["passport", "expiry_date", "2031-03-14"],
      ],
      rel: [["residence-permit", "requires", "passport"], ["player", "owns", "passport"]],
    },
    {
      ago: 18,
      at: "18:30",
      agent: "home-finder",
      kind: "observation",
      text: "Shortlisted a one-bedroom flat in Alfama, 1,050 EUR a month, close to the river.",
      create: [{ type: "location", title: "Alfama flat", slug: "alfama-flat", tags: ["housing"], aliases: ["the Alfama flat"] }],
      facts: [["alfama-flat", "monthly_rent", "1,050 EUR"]],
      rel: [["alfama-flat", "located_in", "lisbon"], ["apartment-hunt", "involves", "alfama-flat"]],
      quest: [["apartment-hunt", { complete: ["Shortlist listings"], clock: { name: "Lease signing", segments: 4, filled: 1, deadline: on(9) } }]],
    },
    {
      ago: 17,
      at: "09:50",
      agent: "campus-agent",
      kind: "fact",
      text: "Semester starts soon; tuition for the first term is 1,250 EUR.",
      facts: [
        ["harbor-university", "semester_start", on(20)],
        ["harbor-university", "tuition_fee", "1,250 EUR"],
      ],
    },
    {
      ago: 16,
      at: "13:15",
      agent: "campus-agent",
      kind: "observation",
      text: "The Migration Agency office is in Alfama, next to the old tram stop.",
      facts: [["migration-agency", "office_address", "Alfama office"]],
    },
    {
      ago: 15,
      at: "17:45",
      agent: "home-finder",
      kind: "observation",
      text: "The agency's public counter is in Belém now, according to the listing site.",
      facts: [["migration-agency", "office_address", "Belém office"]],
    },
    {
      ago: 14,
      at: "10:00",
      agent: "residency-agent",
      kind: "task",
      text: "Health insurance purchased from Acme Health; policy starts this month.",
      create: [{ type: "faction", title: "Acme Health", slug: "acme-health", tags: ["insurance"] }],
      facts: [["acme-health", "policy_start", on(-14)]],
      rel: [["residence-permit", "involves", "acme-health"]],
      quest: [["residence-permit", { complete: ["Health insurance"], clock: { name: "Paperwork", tick: 1 } }]],
    },
    {
      ago: 13,
      at: "19:20",
      agent: "job-scout",
      kind: "observation",
      text: "Heard a monthly metro pass costs 42 EUR.",
      facts: [["lisbon", "metro_pass_price", "42 EUR"]],
    },
    {
      ago: 12,
      at: "08:40",
      agent: "campus-agent",
      kind: "fact",
      text: "Student card office says the monthly metro pass is 40 EUR with the student discount.",
      facts: [["lisbon", "metro_pass_price", "40 EUR"]],
    },
    {
      ago: 11,
      at: "15:05",
      agent: "campus-agent",
      kind: "task",
      text: "Language placement test taken at the HU Language Center: placed at B1.",
      facts: [
        ["language-center", "placement_level", "B1"],
        ["language-center", "placement_test_date", on(-11)],
      ],
      quest: [["university-enrollment", { complete: ["Language placement test"] }]],
    },
    {
      ago: 10,
      at: "12:00",
      agent: "player",
      kind: "decision",
      text: "Rent budget is 1,100 EUR a month, all in. Move into the Alfama flat as soon as the lease allows.",
      facts: [
        ["player", "rent_budget", "1,100 EUR"],
        ["alfama-flat", "move_in_date", on(25)],
      ],
    },
    {
      ago: 9,
      at: "21:10",
      agent: "job-scout",
      kind: "observation",
      text: "Typical T1 rent around the centre is 1,100 EUR.",
      facts: [["lisbon", "avg_rent_t1", "1,100 EUR"]],
    },
    {
      ago: 8,
      at: "16:35",
      agent: "game-master",
      kind: "beat",
      text: "Halfway through the gauntlet: the insurance is sealed, the flat is in sight, the agency keeps moving its counter.",
    },
    {
      ago: 7,
      at: "11:25",
      agent: "campus-agent",
      kind: "observation",
      text: "The student portal locks new accounts until the tuition payment clears.",
      quest: [["university-enrollment", { status: "blocked", add: ["Pay first-term tuition"] }]],
      rel: [["university-enrollment", "requires", "student-portal"]],
    },
    {
      ago: 6,
      at: "10:15",
      agent: "home-finder",
      kind: "fact",
      text: "Landlord confirmed: move-in is possible a week later than planned. Address proof letter promised at signing.",
      facts: [["alfama-flat", "move_in_date", on(32)]],
      quest: [["apartment-hunt", { clock: { name: "Lease signing", tick: 1 } }]],
    },
    {
      ago: 5,
      at: "09:30",
      agent: "home-finder",
      kind: "observation",
      text: "Listings agree: a T1 near the centre goes for about 1,100 EUR.",
      facts: [["lisbon", "avg_rent_t1", "1,100 EUR"]],
    },
    {
      ago: 4,
      at: "18:00",
      agent: "job-scout",
      kind: "observation",
      text: "Harbor Cafe is hiring part-time baristas; walk-ins welcome on weekday mornings.",
      create: [{ type: "location", title: "Harbor Cafe", slug: "harbor-cafe", tags: [] }],
      facts: [["harbor-cafe", "hiring", "part-time baristas"]],
      quest: [["paid-work", { status: "dormant" }]],
    },
    {
      ago: 3,
      at: "14:45",
      agent: "job-scout",
      kind: "observation",
      text: "Someone at the cafe said the university career fair is next month.",
      facts: [["harbor-university", "career_fair_date", on(30)]],
    },
    {
      ago: 2,
      at: "10:20",
      agent: "residency-agent",
      kind: "task",
      text: "Address proof requested from the landlord; online application drafted on the permit portal.",
      quest: [["residence-permit", { complete: ["Address proof"], clock: { name: "Paperwork", tick: 1 } }]],
      rel: [["residence-permit", "requires", "alfama-flat"]],
    },
    {
      ago: 1.4,
      at: "20:05",
      agent: "game-master",
      kind: "beat",
      text: "Previously on the Lisbon Arc: two disputes wait for the player's ruling, and the paperwork clock is half full.",
    },
  ];
}

/** Still in the inbox: written after (or held back from) the last sleep. */
function pending(): { hoursAgo: number; agent: string; kind: EpisodeKind; text: string; about?: string[]; secret?: boolean; confidence?: number }[] {
  return [
    { hoursAgo: 30, agent: "campus-agent", kind: "question", text: "Does the language course count toward the residence-permit study requirement?", about: ["[[language-center]]", "[[residence-permit]]"], confidence: 0.4 },
    { hoursAgo: 6, agent: "residency-agent", kind: "fact", text: "Agency confirmed the appointment by email; bring two biometric photos and the signed lease.", about: ["[[migration-agency]]", "[[residence-permit]]"], confidence: 0.9 },
    { hoursAgo: 5, agent: "residency-agent", kind: "fact", text: "Residence card application reference received.", about: ["[[residence-permit]]"], secret: true },
    { hoursAgo: 3, agent: "home-finder", kind: "task", text: "Lease draft received for the Alfama flat; signing slot offered for Friday.", about: ["[[alfama-flat]]", "[[apartment-hunt]]"], confidence: 0.8 },
    { hoursAgo: 2, agent: "job-scout", kind: "observation", text: "Harbor Cafe trial shift could be on Saturday morning.", about: ["[[harbor-cafe]]"] },
    { hoursAgo: 1, agent: "calendar-bot", kind: "observation", text: "Placed a reminder for the agency appointment the day before.", about: ["[[migration-agency]]"] },
  ];
}

/** Local `HH:MM` on the day `ago` days before `now`, as an ISO instant (approximate: the time zone offset is folded in once). */
function instant(now: Date, ago: number, time: string, tz: string): string {
  const day = new Date(now.getTime() - ago * 86400_000);
  const [h, m] = time.split(":").map(Number) as [number, number];
  const local = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m));
  const offset = tzOffsetMinutes(local, tz);
  return new Date(local.getTime() - offset * 60_000).toISOString();
}

function tzOffsetMinutes(at: Date, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

function isStore(x: VaultStore | Record<string, string>): x is VaultStore {
  return typeof (x as VaultStore).list === "function";
}

async function copyStore(from: VaultStore | Record<string, string>): Promise<MemoryStore> {
  if (!isStore(from)) return new MemoryStore({ ...from });
  const files: Record<string, string> = {};
  for (const path of await from.list()) {
    const content = await from.read(path);
    if (content !== undefined) files[path] = content;
  }
  return new MemoryStore(files);
}

/**
 * Build the demo vault from the seed (a store or a path→content map) as of `now`.
 * Every timestamp is relative to `now`, so the demo always looks like it's mid-campaign.
 */
export async function buildDemoStore(seed: VaultStore | Record<string, string>, opts: { now?: Date } = {}): Promise<MemoryStore> {
  const now = opts.now ?? new Date();
  const store = await copyStore(seed);
  const config = (await store.read("_hippo/config.yaml")) ?? "";
  // A throwaway key: the demo's secret is really encrypted, and nobody can read it back.
  const { recipient } = await generateKeyPair();
  await store.write("_hippo/config.yaml", config.replace(/recipient:\s*null/, `recipient: ${recipient}`));

  let clock = now;
  const vault = await Vault.load(store, { now: () => clock });
  const tz = vault.config.timezone;
  const on = (days: number) => new Date(now.getTime() + days * 86400_000).toISOString().slice(0, 10);
  const get = (slug: string): Entity => {
    const e = vault.entities.get(slug);
    if (!e) throw new Error(`demo script refers to unknown entity ${slug}`);
    return e;
  };

  for (const step of script(on)) {
    const at = instant(now, step.ago, step.at, tz);
    clock = new Date(at);
    const ep = createEpisode(vault.config.folders.inbox, { agent: step.agent, kind: step.kind, text: step.text, at, secret: step.secret }, clock);
    const prov = { by: step.agent, at, src: [ep.id] };
    const touched = new Set<string>();
    for (const c of step.create ?? []) touched.add(vault.createEntity({ ...c, by: step.agent }).slug);
    for (const [slug, field, value, secret] of step.facts ?? []) {
      await applyFact(vault, get(slug), field, value, prov, { secret });
      touched.add(slug);
    }
    for (const [from, rel, to] of step.rel ?? []) {
      addRelation(vault, get(from), rel, get(to), prov);
      touched.add(from).add(to);
    }
    for (const [slug, update] of step.quest ?? []) {
      applyQuestUpdate(vault, get(slug), update, step.agent);
      touched.add(slug);
    }
    if (step.agent === "game-master") touched.add("lisbon-arc");
    // Secret-bearing episodes reach the chronicle redacted, as the curator writes them.
    await vault.appendChronicle(ep, [...touched], step.secret ? step.text.replace(/X\d+/g, "[redacted]") : step.text);
  }

  // The player already settled one dispute (the agency counter moved back to Alfama).
  clock = new Date(now.getTime() - 26 * 3600_000);
  const counter = vault.disputes.get(vault.disputeSlug("migration-agency", "office_address"));
  if (counter) applyRuling(vault, counter, "Alfama office");

  const lastSleep = new Date(now.getTime() - 8 * 3600_000).toISOString();
  clock = new Date(lastSleep);
  vault.writeFile(
    REVIEW_PATH,
    renderDoc({ type: "review", generated: lastSleep }, "# 🌙 Morning review\n\nGenerated by the demo campaign. Open the dashboard's Council and Tavern for the live view.\n"),
  );
  vault.writeFile(HANDBOOK_PATH, renderHandbook(vault));
  await vault.flush({ message: "demo: three weeks of the Lisbon Arc" });

  // Episodes still waiting for the next sleep go in after it, through the normal `remember` path.
  const inbox = await Vault.load(store, { now: () => now });
  for (const p of pending()) {
    const at = new Date(now.getTime() - p.hoursAgo * 3600_000);
    inbox.addEpisode(createEpisode(inbox.config.folders.inbox, { ...p, at: at.toISOString() }, at));
  }
  await inbox.flush({ message: "demo: pending episodes" });
  return store;
}

export { demoSetup } from "./demo-setup.ts";
