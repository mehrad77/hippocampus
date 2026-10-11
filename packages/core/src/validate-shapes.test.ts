import { describe, expect, it } from "vitest";
import { CONFIG, fixtureStore } from "./__fixtures__/vault.ts";
import { Vault } from "./vault.ts";
import { fieldUsage, validateShapes } from "./validate-shapes.ts";

const config = CONFIG.replace(
  "  character: { folder: characters, description: People }",
  "  character: { folder: characters, description: People, fields: { birthday: date, size: number, tier: { kind: enum, values: [gold, silver] }, employer: { kind: ref } } }",
).replace("relations:", "kinds:\n  call: { behaviour: interaction, text: forbidden, data: { with: { kind: ref } } }\nrelations:");

async function vault(files: Record<string, string>) {
  return Vault.load(fixtureStore({ "_hippo/config.yaml": config, ...files }));
}

describe("validateShapes", () => {
  it("flags undeclared fields of shaped types and values of the wrong kind, never the values", async () => {
    const v = await vault({
      "characters/joao-silva.md":
        "---\ntype: character\ntitle: João Silva\nfacts:\n  birthday: next spring\n  size: 3\n  tier: Gold\n  employer: \"[[harbor-university]]\"\n  phone: \"+351 900 000 001\"\n---\n",
      "factions/harbor-university.md": "---\ntype: faction\ntitle: Harbor University\nfacts:\n  founded: 1911\n---\n",
    });
    const found = validateShapes(v);
    expect(found).toEqual([
      { path: "characters/joao-silva.md", rule: "kind-mismatch", message: "birthday should be an ISO date" },
      { path: "characters/joao-silva.md", rule: "undeclared-field", message: 'phone isn\'t a field of type "character"' },
    ]);
    expect(JSON.stringify(found)).not.toContain("next spring");
    // An unshaped type (no fields declared) isn't flagged per fact; field usage lists what it uses.
    expect(fieldUsage(v)).toEqual([
      { type: "character", fields: [{ field: "phone", count: 1 }] },
      { type: "faction", fields: [{ field: "founded", count: 1 }] },
    ]);
  });

  it("flags pending episodes of unknown kinds and data links to no note", async () => {
    const v = await vault({
      "inbox/home-finder/a.md": "---\nagent: home-finder\nkind: telepathy\nat: 2026-09-27T10:00:00Z\n---\nSomething.\n",
      "inbox/home-finder/b.md": '---\nagent: home-finder\nkind: call\nat: 2026-09-27T11:00:00Z\ndata:\n  with: "[[nobody-known]]"\n---\n',
      "inbox/home-finder/c.md": '---\nagent: home-finder\nkind: call\nat: 2026-09-27T12:00:00Z\ndata:\n  with: ["[[migration-agency]]", player]\n---\n',
    });
    expect(validateShapes(v)).toEqual([
      { path: "inbox/home-finder/a.md", rule: "unknown-kind", message: 'unknown kind "telepathy"; filed as an observation' },
      { path: "inbox/home-finder/b.md", rule: "unresolved-ref", message: "data.with links to no note" },
    ]);
  });
});
