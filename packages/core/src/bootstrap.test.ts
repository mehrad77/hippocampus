import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { buildVaultFiles, patchConfig } from "./bootstrap.ts";
import { CONFIG_PATH, parseConfig } from "./config.ts";
import { HANDBOOK_PATH } from "./handbook.ts";
import { MemoryStore } from "./store.ts";
import { Vault } from "./vault.ts";

const ROOT = join(import.meta.dirname, "../../..");

function readDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (statSync(join(dir, rel)).isFile()) out[rel.split(sep).join("/")] = readFileSync(join(dir, rel), "utf8");
  }
  return out;
}

const template = readDir(join(ROOT, "vault-template"));
const seed = readDir(join(ROOT, "seeds/example-relocation"));

describe("buildVaultFiles", () => {
  it("fills in the config, gives the PC to the human, and renders a loadable vault with its guardrails", async () => {
    const before = structuredClone(template);
    const files = await buildVaultFiles(template, {
      campaign: "lisbon-arc",
      human: "student",
      timezone: "Europe/Lisbon",
      domains: ["residency", "housing"],
      recipient: "age1examplerecipient",
    });
    expect(template).toEqual(before);
    expect(Object.keys(files)).toEqual(Object.keys(files).sort());

    const raw = files[CONFIG_PATH]!;
    expect(raw).toContain("# Party id of the human player.");
    expect(raw).toMatch(/^domains: \[ ?residency, housing ?\]$/m);
    expect(parseConfig(raw)).toMatchObject({ campaign: "lisbon-arc", human: "student", timezone: "Europe/Lisbon", secrets: { recipient: "age1examplerecipient" } });

    expect(files["characters/player.md"]).toBeUndefined();
    expect(files[HANDBOOK_PATH]).toContain("lisbon-arc");
    for (const path of ["AGENTS.md", "CLAUDE.md", "_hippo/curator.md", ".github/workflows/validate.yml", ".gitignore", "inbox/README.md", "secrets/.gitkeep"])
      expect(files[path], path).toBeDefined();

    const vault = await Vault.load(new MemoryStore(files));
    expect(vault.warnings).toEqual([]);
    expect([...vault.entities.keys()]).toEqual(["student"]);
    expect(vault.entities.get("student")?.fm).toMatchObject({ type: "character", title: "Student", tags: ["pc"] });
    expect(vault.episodes).toEqual([]);
  });

  it("lays a seed over the template and keeps its player character", async () => {
    const files = await buildVaultFiles(template, { seed });
    const vault = await Vault.load(new MemoryStore(files));
    expect(vault.warnings).toEqual([]);
    expect(vault.config.campaign).toBe("lisbon-arc");
    expect(vault.entities.has("player")).toBe(true);
    expect(vault.entities.has("residency-agent")).toBe(true);
    expect(files[HANDBOOK_PATH]).toContain("`residency-agent`");
    expect(files["AGENTS.md"]).toBe(template["AGENTS.md"]);
  });

  it("drops the placeholder PC when the seed brings the human's own note", async () => {
    const own = { "characters/student.md": "---\ntype: character\ntitle: Student\ntags: [pc]\n---\nThe human.\n" };
    const files = await buildVaultFiles(template, { seed: own, human: "student" });
    expect(files["characters/player.md"]).toBeUndefined();
    expect(files["characters/student.md"]).toContain("title: Student");
  });

  it("is already normalized: building from its own output changes nothing", async () => {
    const opts = { seed, human: "student", campaign: "lisbon-arc" };
    const once = await buildVaultFiles(template, opts);
    expect(await buildVaultFiles(once, opts)).toEqual(once);
  });

  it("refuses settings that would make an unusable vault", async () => {
    await expect(buildVaultFiles(template, { human: "Not An Id" })).rejects.toThrow(/must be an id/);
    await expect(buildVaultFiles(template, { timezone: "Mars/Olympus" })).rejects.toThrow(/unknown timezone/);
    await expect(buildVaultFiles(template, { domains: ["Housing"] })).rejects.toThrow(/domain "Housing"/);
    await expect(buildVaultFiles({ "README.md": "# empty" })).rejects.toThrow(/no _hippo\/config.yaml/);
  });
});

describe("patchConfig", () => {
  it("only touches the settings it is given", () => {
    const raw = template[CONFIG_PATH]!;
    expect(parseConfig(patchConfig(raw, {}))).toEqual(parseConfig(raw));
    const patched = parseConfig(patchConfig(raw, { recipient: "age1x" }));
    expect(patched).toEqual({ ...parseConfig(raw), secrets: { ...parseConfig(raw).secrets, recipient: "age1x" } });
  });
});
