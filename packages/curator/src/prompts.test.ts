import { Vault } from "@hippocampus/core";
import { describe, expect, it } from "vitest";
import { fixtureStore } from "../../core/src/__fixtures__/vault.ts";
import { now } from "./__fixtures__/night.ts";
import { claimsPrompt, claimsSchema, mentionsPrompt, summaryPrompt } from "./prompts.ts";

const long = "x".repeat(200);
const TYPE_NOTE = `---\nfolder: characters\n---\nA person the human knows.\n\n## Is\n- A colleague at Harbor University\n- The landlord\n- A third example that isn't shown\n\n## Is not\n- An agent of the party\n- ${long}\n`;

async function vault() {
  const store = fixtureStore({
    "_hippo/schema/types/character.md": TYPE_NOTE,
    "inbox/home-finder/2026-09-27T100000-call.md":
      '---\nagent: home-finder\nkind: interaction\nat: 2026-09-27T10:00:00Z\nscope: lang:pt\ndata:\n  with: "[[joao-silva]]"\n  channel: phone\n---\nTalked about the lease.\n',
  });
  // The inline type would override the note's description: drop it so the note speaks.
  await store.write("_hippo/config.yaml", (await store.read("_hippo/config.yaml"))!.replace("  character: { folder: characters, description: People }\n", ""));
  return Vault.load(store, { now });
}

describe("prompts", () => {
  it("speak of a shared memory vault, not a campaign", async () => {
    const v = await vault();
    const ep = v.episodes[0]!;
    const all = [mentionsPrompt(v, ep), claimsPrompt(v, ep, [], [])].map((p) => `${p.system}\n${p.prompt}`).join("\n");
    expect(all).toContain('You are the curator of a shared memory vault ("lisbon-arc") that several AI agents write to about one person\'s life and work.');
    expect(all).not.toMatch(/campaign|tabletop|RPG|quest/i);
  });

  it("describe each type with at most two short examples a side, and leave agents out", async () => {
    const { system } = mentionsPrompt(await vault(), (await vault()).episodes[0]!);
    expect(system).toContain(`- character: A person the human knows.\n    is: A colleague at Harbor University; The landlord\n    is not: An agent of the party; ${"x".repeat(119)}…`);
    expect(system).not.toContain("A third example");
    expect(system).not.toMatch(/^- party:/m);
  });

  it("show the episode's kind, scope and data", async () => {
    const v = await vault();
    const { prompt } = mentionsPrompt(v, v.episodes[0]!);
    expect(prompt).toContain("Kind: interaction (A contact with someone: a call, a meeting, a message.)");
    expect(prompt).toContain("Scope: lang:pt");
    expect(prompt).toContain('Data:\n  with: "[[joao-silva]]"\n  channel: phone');
  });

  it("ask for answered questions only when there are open ones, and allow the goal type's statuses", async () => {
    const v = await vault();
    const without = claimsSchema(v, ["migration-agency"], { goals: ["residence-permit"] });
    expect(without.parse({ facts: [], relations: [], answered: ["q-1"] })).not.toHaveProperty("answered");
    const withQ = claimsSchema(v, ["migration-agency"], { goals: ["residence-permit"], questions: ["q-1"] });
    expect(withQ.parse({ facts: [], relations: [], answered: ["q-1"] }).answered).toEqual(["q-1"]);
    expect(() => withQ.parse({ facts: [], relations: [], answered: ["q-2"] })).toThrow();
    expect(() => withQ.parse({ facts: [], relations: [], goals: [{ goal: "residence-permit", status: "won", completed: [], added: [] }] })).toThrow();
  });

  it("mask confidential values and identity keys in the summary step", async () => {
    const v = await vault();
    const agency = v.entities.get("migration-agency")!;
    agency.fm.facts.director = { value: "Rui Costa", status: "canon", src: [], confidential: true };
    agency.fm.facts.city = { value: "Lisbon", status: "canon", src: [] };
    const { prompt } = summaryPrompt(v, agency, ["(confidential)"]);
    expect(prompt).toContain("- director: ◐ confidential (canon)");
    expect(prompt).toContain("- city: Lisbon (canon)");
    expect(prompt).not.toContain("Rui Costa");
  });
});

describe("claims prompt (finding 7)", () => {
  it("masks hidden facts as the summary step does", async () => {
    const store = fixtureStore({
      "characters/landlord.md": "---\ntype: character\ntitle: The landlord\nfacts:\n  salary: { value: 4200 EUR, status: canon, confidential: true }\n  phone: { value: +351 900 000 001, status: canon }\n---\n",
      "inbox/home-finder/2026-09-27T100000-a.md": "---\nagent: home-finder\nkind: fact\nat: 2026-09-27T10:00:00Z\n---\nThe landlord called.\n",
    });
    const v = await Vault.load(store, { now });
    const { prompt } = claimsPrompt(v, v.episodes[0]!, [v.resolve("landlord")!], []);
    expect(prompt).toContain("salary=◐ confidential");
    expect(prompt).not.toContain("4200");
    expect(prompt).toContain("phone=+351 900 000 001");
  });
});
