import { describe, expect, it } from "vitest";
import { CONFIG, fixtureStore } from "./__fixtures__/vault.ts";
import { CONFIG_PATH, addDomains, parseConfig } from "./config.ts";
import { HANDBOOK_PATH } from "./handbook.ts";
import { HippoService } from "./service.ts";
import type { MemoryStore, VaultStore } from "./store.ts";

const now = () => new Date("2026-09-27T12:00:00.000Z");

/** `store` with an atomic `apply` that records each commit message. */
function recording(store: MemoryStore): { store: VaultStore; messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    store: {
      list: (prefix) => store.list(prefix),
      read: (path) => store.read(path),
      write: (path, content) => store.write(path, content),
      remove: (path) => store.remove(path),
      async apply(changes, meta) {
        messages.push(meta.message);
        for (const c of changes) await ("remove" in c ? store.remove(c.path) : store.write(c.path, c.content));
      },
    },
  };
}

describe("adding domains to the config", () => {
  const raw = "version: 2\nname: lisbon-arc\n# Domains are the tags that define lanes.\ndomains: [residency, Housing]\nrelations: [part_of]\n";

  it("appends new ids, keeping the comment and the rest of the file", () => {
    const next = addDomains(raw, ["health", " Side-Project "]);
    expect(next).toContain("# Domains are the tags that define lanes.\ndomains: [residency, Housing, health, side-project]\n");
    expect(next.replace(/^domains:.*\n/m, "")).toBe(raw.replace(/^domains:.*\n/m, ""));
  });

  it("returns the config itself when it has them all, whatever their case", () => {
    expect(addDomains(raw, ["housing", "RESIDENCY", "housing"])).toBe(raw);
  });

  it("creates the list when the config has none", () => {
    expect(parseConfig(addDomains("version: 2\nname: lisbon-arc\n", ["career"])).domains).toEqual(["career"]);
  });

  it("refuses something that isn't an id", () => {
    expect(() => addDomains(raw, ["Side Project!"])).toThrow(/domain "side project!" must be lowercase letters, digits and dashes/);
  });
});

describe("HippoService.addDomains", () => {
  it("commits the config and the Handbook once, as the human", async () => {
    const memory = fixtureStore();
    const { store, messages } = recording(memory);
    const service = new HippoService(store, { now });
    expect(await service.addDomains(["health", "career"], { via: "@player" })).toMatchObject({ added: ["health"] });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/^config\(player via @player\): add domain health\n\nHippo-Actor: human/);
    expect(parseConfig(await memory.read(CONFIG_PATH)).domains).toEqual(["residency", "housing", "university", "career", "health"]);
    expect(await memory.read(HANDBOOK_PATH)).toContain("`health`");
  });

  it("commits nothing when the vault has them all", async () => {
    const { store, messages } = recording(fixtureStore());
    expect(await new HippoService(store, { now }).addDomains(["Housing"])).toEqual({ added: [] });
    expect(messages).toEqual([]);
  });

  it("lets a new domain be given to an agent right away", async () => {
    const service = new HippoService(fixtureStore(), { now });
    await expect(service.addPartyMember({ id: "health-agent", title: "Health Agent", authority: ["health"] })).rejects.toThrow(/unknown domain health/);
    await service.addDomains(["health"]);
    expect(await service.addPartyMember({ id: "health-agent", title: "Health Agent", authority: ["health"] })).toMatchObject({ slug: "health-agent" });
  });

  it("refuses an id before writing anything", async () => {
    const memory = fixtureStore();
    await expect(new HippoService(memory, { now }).addDomains(["health care"])).rejects.toThrow(/must be lowercase letters/);
    expect(await memory.read(CONFIG_PATH)).toBe(CONFIG);
  });
});
