import { MemoryStore, generateKeyPair, parseDoc, decryptSecret } from "@hippocampus/core";
import { describe, expect, it } from "vitest";
import { fixtureStore } from "../../core/src/__fixtures__/vault.ts";
import { ScriptedLLM } from "./llm.ts";
import { sleep } from "./sleep.ts";

const now = () => new Date("2026-09-27T21:00:00.000Z");

const episode = (agent: string, at: string, text: string, extra = "") =>
  `---\nagent: ${agent}\nkind: fact\nat: ${at}\n${extra}---\n${text}\n`;

async function setup() {
  const { identity, recipient } = await generateKeyPair();
  const store: MemoryStore = fixtureStore({
    "inbox/residency-agent/2026-09-27T100000-agency.md": episode(
      "residency-agent",
      "2026-09-27T10:00:00Z",
      "agency appointment booked for 2026-10-14 10:30. Passport number U12345678 needed.",
      "secret: true\n",
    ),
    "inbox/campus-agent/2026-09-27T110000-rumor.md": episode("campus-agent", "2026-09-27T11:00:00Z", "Heard from a classmate the Lisbon Migration Office appointment is 2026-10-15."),
    "inbox/home-finder/2026-09-27T120000-landlord.md": episode("home-finder", "2026-09-27T12:00:00Z", "New landlord is João Silva, phone +351 900 000 001."),
  });
  await store.write("_hippo/config.yaml", `${(await store.read("_hippo/config.yaml"))!}secrets:\n  recipient: ${recipient}\n`);
  return { store, identity };
}

function script() {
  return new ScriptedLLM()
    .push(
      "mentions",
      { entities: [{ name: "Agência de Migração", type: "faction", aliases: ["the agency"], domains: ["residency"] }, { name: "Passport", type: "item", aliases: [], domains: ["residency"] }] },
      { entities: [{ name: "Lisbon Migration Office", type: "faction", aliases: [], domains: [] }] },
      { entities: [{ name: "João Silva", type: "character", aliases: [], domains: ["housing"] }] },
    )
    .push("match", { match: "migration-agency" })
    .push(
      "claims",
      {
        facts: [
          { entity: "migration-agency", field: "appointment_date", value: "2026-10-14T10:30", secret: false },
          { entity: "passport", field: "number", value: "U12345678", secret: true },
        ],
        relations: [],
        quests: [{ quest: "residence-permit", status: "unchanged", completed: ["Book agency appointment"], added: [] }],
      },
      { facts: [{ entity: "migration-agency", field: "appointment date", value: "2026-10-15", secret: false }], relations: [], quests: [] },
      { facts: [{ entity: "joao-silva", field: "phone", value: "+351 900 000 001", secret: false }], relations: [], quests: [] },
    )
    .respond("summary", ({ prompt }) => ({ summary: `Summary of ${prompt.split("\n")[0]}` }));
}

describe("sleep", () => {
  it("consolidates the inbox into canon, chronicle and review", async () => {
    const { store, identity } = await setup();
    const llm = script();
    const report = await sleep({ store, llm, now });

    expect(report.failed).toEqual([]);
    expect(report.remaining).toBe(0);
    expect(await store.list("inbox")).toEqual([]);

    // Authority: Residency Agent owns residency facts; Campus Agent's rumor doesn't override.
    const agency = parseDoc((await store.read("factions/migration-agency.md"))!).data as any;
    expect(agency.facts.appointment_date).toMatchObject({ value: "2026-10-14T10:30", status: "canon", by: "residency-agent" });
    expect(report.consolidated[1]!.facts[0]).toMatchObject({ decision: "keep" });
    // Alias learned from the LLM match step.
    expect(agency.aliases).toContain("Lisbon Migration Office");

    // New NPC created in the right folder, tagged with the housing domain, so Home Finder is authoritative.
    const joao = parseDoc((await store.read("characters/joao-silva.md"))!).data as any;
    expect(joao.tags).toEqual(["housing"]);
    expect(joao.facts.phone).toMatchObject({ value: "+351 900 000 001", status: "canon" });

    // Secret encrypted, redacted from the chronicle and the note.
    const passport = (await store.read("items/passport.md"))!;
    expect(passport).toContain("secret://passport/number");
    expect(await decryptSecret(identity, (await store.read("secrets/passport/number.age"))!)).toBe("U12345678");
    const chronicle = (await store.read("chronicle/2026/09/2026-09-27.md"))!;
    expect(chronicle).not.toContain("U12345678");
    expect(chronicle).toContain("[redacted]");
    expect(chronicle.match(/\[!episode\]/g)).toHaveLength(3);

    // Quest progress.
    expect(await store.read("quests/residence-permit.md")).toContain("- [x] Book agency appointment");

    // Summaries written into the managed region; human prose kept.
    const agencyRaw = (await store.read("factions/migration-agency.md"))!;
    expect(agencyRaw).toContain("%% hippo:begin summary %%\nSummary of Entity: migration-agency");
    expect(agencyRaw).toContain("Human prose that must survive.");

    // No secret ever reached a prompt after extraction steps.
    const summaryPrompts = llm.calls.filter((c) => c.name === "summary").map((c) => c.prompt).join("\n");
    expect(summaryPrompts).not.toContain("U12345678");

    expect(await store.read("_hippo/review.md")).toContain("3 episodes consolidated");
    expect(await store.read("HANDBOOK.md")).toContain("1/2 objectives");
  });

  it("leaves episodes in the inbox when the model fails, and dry-run writes nothing", async () => {
    const { store } = await setup();
    const before = new Map((store as MemoryStore).files);
    const report = await sleep({ store, llm: new ScriptedLLM(), now, dryRun: true });
    expect(report.failed).toHaveLength(3);
    expect((store as MemoryStore).files).toEqual(before);
  });
});
