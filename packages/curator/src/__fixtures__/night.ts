import { MemoryStore, generateKeyPair } from "@hippocampus/core";
import { fixtureStore } from "../../../core/src/__fixtures__/vault.ts";
import { ScriptedLLM } from "../llm.ts";

// One night of the example campaign, shared by the classic sleep and the relay tests so both curate the same inbox.

export const now = () => new Date("2026-09-27T21:00:00.000Z");

export const episode = (agent: string, at: string, text: string, extra = "") => `---\nagent: ${agent}\nkind: fact\nat: ${at}\n${extra}---\n${text}\n`;

export async function setup() {
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

export function script() {
  return new ScriptedLLM()
    .push(
      "mentions",
      { entities: [{ name: "Agência de Migração", type: "faction", aliases: ["the agency"], domains: ["residency"] }, { name: "Passport", type: "item", aliases: ["U12345678"], domains: ["residency"] }] },
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
