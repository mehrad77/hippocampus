import { CURATOR_RULES_PATH, CURRENT_VAULT_VERSION, buildVaultFiles } from "@hippocampus/core";
import type { HttpError } from "@hippocampus/dashboard";
import { TEMPLATE } from "@hippocampus/template";
import { beforeAll, describe, expect, it } from "vitest";
import { V1_FILES } from "../../../../packages/core/src/__fixtures__/v1-vault.ts";
import { BOOTSTRAP_AUTHOR, GUARDRAIL_FILES, VAULT_PERMISSIONS, bootstrapVault, migrationCommit, plan } from "./bootstrap.ts";
import { GitHubApp } from "./github-app.ts";
import { Registry } from "./registry.ts";
import { APP, appKeyPair, hostedGitHub, registryDb } from "./testing.ts";

let keys: Awaited<ReturnType<typeof appKeyPair>>;
beforeAll(async () => {
  keys = await appKeyPair();
});

const SETTINGS = { campaign: "Lisbon relocation", human: "player", timezone: "Europe/Lisbon", domains: ["residency", "housing"] };
const NOW = new Date("2026-10-01T09:00:00.000Z");

async function setup(opts: { permissions?: Record<string, "read" | "write"> } = {}) {
  const github = await hostedGitHub(keys);
  const { gh } = github;
  const installation = gh.addInstallation({ account: { id: 4242, login: "player", type: "User" }, repos: ["player/vault"], permissions: opts.permissions });
  const app = new GitHubApp({ appId: APP.id, privateKey: keys.privateKeyPem, apiUrl: "https://api.github.test", fetch: github.fetch });
  const registry = new Registry(await registryDb(), () => NOW);
  await registry.signIn({ id: 4242, login: "player" });
  await registry.setAccountStatus(4242, "approved");
  const addRepo = async (fullName: string, id: number, files: Record<string, string> | undefined, isPrivate = true) => {
    await gh.addRepo({ fullName, id, files, empty: files === undefined, private: isPrivate });
    installation.repos.push(fullName);
    return { id, fullName };
  };
  const run = (repo: { id: number; fullName: string }, extra: { seed?: string; presets?: string[] } = {}) =>
    bootstrapVault({ app, registry, accountId: 4242, installationId: installation.id, repo, settings: SETTINGS, now: NOW, ...extra });
  return { gh, app, registry, installation, addRepo, run };
}

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err as HttpError;
  }
  throw new Error("expected a refusal");
};

describe("bootstrapVault", () => {
  it("initializes an empty repo in two commits, through a token for that repo alone", async () => {
    const { gh, registry, run } = await setup();
    const result = await run({ id: 9001, fullName: "player/vault" });
    expect(result.mode).toBe("initialized");
    expect(result.vault).toMatchObject({ status: "ready", fullName: "player/vault", repoId: 9001, branch: "main", accountId: 4242 });
    expect(await registry.vaultOf(4242)).toEqual(result.vault);

    const repo = gh.at("player/vault");
    const log = repo.log();
    expect(log).toHaveLength(2);
    for (const c of log) {
      expect(c.message).toBe("chore: initialize Hippocampus vault [skip ci]\n\nHippo-Actor: bootstrap");
      expect(c.author).toEqual(BOOTSTRAP_AUTHOR);
    }
    const files = repo.files();
    expect(Object.keys(files).sort()).toEqual(Object.keys(await buildVaultFiles(TEMPLATE, { ...SETTINGS, now: NOW })).sort());
    for (const path of GUARDRAIL_FILES) expect(files[path]).toBe(TEMPLATE[path]);
    expect(files["_hippo/config.yaml"]).toContain("name: Lisbon relocation");
    expect(files["_hippo/config.yaml"]).toContain("timezone: Europe/Lisbon");

    const minted = [...gh.tokens.values()].filter((t) => t.installation !== undefined);
    expect(minted).toEqual([expect.objectContaining({ repos: ["player/vault"], permissions: VAULT_PERMISSIONS })]);
  });

  it("lays the example campaign over the template when asked", async () => {
    const { gh, run } = await setup();
    await run({ id: 9001, fullName: "player/vault" }, { seed: "example-relocation" });
    expect(Object.keys(gh.at("player/vault").files())).toContain("party/home-finder.md");
  });

  it("initializes over GitHub's starter files, keeping a LICENSE the template lacks", async () => {
    const { gh, run, addRepo } = await setup();
    const repo = await addRepo("player/fresh", 9003, { "README.md": "# fresh\n", LICENSE: "MIT License\n" });
    expect((await run(repo)).mode).toBe("initialized");
    const files = gh.at("player/fresh").files();
    expect(files["README.md"]).toBe(TEMPLATE["README.md"]);
    expect(files.LICENSE).toBe("MIT License\n");
    expect(files[".github/workflows/validate.yml"]).toBeDefined();
    expect(gh.at("player/fresh").log()).toHaveLength(2);
  });

  it("adopts an existing vault, adding only the guardrail files it lacks", async () => {
    const { gh, run, addRepo } = await setup();
    const existing = await buildVaultFiles(TEMPLATE, { ...SETTINGS, now: NOW });
    for (const path of GUARDRAIL_FILES) delete existing[path];
    existing["AGENTS.md"] = "# The party's own rules\n";
    existing["README.md"] = "# Our vault\n";
    const repo = await addRepo("player/old-vault", 9004, existing);
    const result = await run(repo);
    expect(result.mode).toBe("adopted");
    const after = gh.at("player/old-vault");
    const files = after.files();
    expect(files["AGENTS.md"]).toBe("# The party's own rules\n");
    expect(files["README.md"]).toBe("# Our vault\n");
    for (const path of ["CLAUDE.md", CURATOR_RULES_PATH, ".github/workflows/validate.yml"]) expect(files[path]).toBe(TEMPLATE[path]);
    const before = Object.keys(existing);
    expect(Object.keys(files).filter((p) => !before.includes(p)).sort()).toEqual([".github/workflows/validate.yml", "CLAUDE.md", CURATOR_RULES_PATH].sort());
    expect(after.log()).toHaveLength(2);
    expect(after.log()[0]!.message).toBe("chore: add Hippocampus guardrail files [skip ci]\n\nHippo-Actor: bootstrap");
  });

  it("adopts an older vault as it is, and refuses one newer than the app", async () => {
    const { run, addRepo } = await setup();
    const existing = await buildVaultFiles(TEMPLATE, { ...SETTINGS, now: NOW });
    const older = { ...existing, "_hippo/config.yaml": existing["_hippo/config.yaml"]!.replace(`version: ${CURRENT_VAULT_VERSION}`, `version: ${CURRENT_VAULT_VERSION - 1}`) };
    expect((await run(await addRepo("player/older-vault", 9007, older))).mode).toBe("adopted");
    const newer = { ...existing, "_hippo/config.yaml": existing["_hippo/config.yaml"]!.replace(`version: ${CURRENT_VAULT_VERSION}`, `version: ${CURRENT_VAULT_VERSION + 1}`) };
    const err = await refusal(run(await addRepo("player/newer-vault", 9008, newer)));
    expect(err.code).toBe("BAD_VAULT");
    expect(err.message).toMatch(/newer than this Hippocampus/);
  });

  it("refuses presets for a repo that already holds a vault, before writing anything", async () => {
    const { gh, registry, run, addRepo } = await setup();
    const existing = await buildVaultFiles(TEMPLATE, { ...SETTINGS, now: NOW });
    const repo = await addRepo("player/old-vault", 9004, existing);
    const err = await refusal(run(repo, { presets: ["people"] }));
    expect(err).toMatchObject({ status: 400, code: "PRESETS_NEW_ONLY" });
    expect(err.message).toMatch(/presets apply only to new vaults/);
    expect(gh.at("player/old-vault").log()).toHaveLength(1);
    expect(await registry.vaultOf(4242)).toBeUndefined();
    // A new vault takes them.
    await run({ id: 9001, fullName: "player/vault" }, { presets: ["people"] });
    expect(gh.at("player/vault").files()["_hippo/config.yaml"]).toMatch(/^presets: \[people\]$/m);
  });

  it("knows only its own presets and seeds, not an object's properties", async () => {
    const { run } = await setup();
    expect(await refusal(run({ id: 9001, fullName: "player/vault" }, { presets: ["constructor"] }))).toMatchObject({ status: 400, code: "INVALID" });
    expect(await refusal(run({ id: 9001, fullName: "player/vault" }, { seed: "toString" }))).toMatchObject({ status: 400, code: "INVALID" });
  });

  it("adopts a v1 vault without migrating it: its owner upgrades it from the dashboard", async () => {
    const { gh, run, addRepo } = await setup();
    const result = await run(await addRepo("player/v1-vault", 9009, V1_FILES));
    expect(result.mode).toBe("adopted");
    const files = gh.at("player/v1-vault").files();
    for (const [path, content] of Object.entries(V1_FILES)) expect(files[path]).toBe(content);
    expect(Object.keys(files).filter((p) => !(p in V1_FILES)).sort()).toEqual([...GUARDRAIL_FILES].sort());
  });

  it("names the migration commit after the format, without [skip ci], as the migration actor", () => {
    expect(migrationCommit(CURRENT_VAULT_VERSION)).toEqual({
      message: `chore: migrate vault to format v${CURRENT_VAULT_VERSION}\n\nHippo-Actor: migration`,
      author: BOOTSTRAP_AUTHOR,
    });
  });

  it("refuses a public repo before writing or registering anything", async () => {
    const { gh, registry, run, addRepo } = await setup();
    const repo = await addRepo("player/open", 9005, undefined, false);
    expect((await refusal(run(repo))).code).toBe("PUBLIC_REPO");
    expect(gh.at("player/open").empty).toBe(true);
    expect(await registry.vaultOf(4242)).toBeUndefined();
  });

  it("refuses a repo that already has other files", async () => {
    const { gh, registry, run, addRepo } = await setup();
    const repo = await addRepo("player/project", 9006, { "README.md": "# project\n", "src/index.ts": "export {};\n" });
    const err = await refusal(run(repo));
    expect(err.code).toBe("NOT_EMPTY");
    expect(err.message).toMatch(/pick an empty repo/);
    expect(gh.at("player/project").log()).toHaveLength(1);
    expect(await registry.vaultOf(4242)).toBeUndefined();
  });

  it("explains an installation that hasn't granted the workflows permission", async () => {
    const { registry, run } = await setup({ permissions: { metadata: "read", contents: "write" } });
    const err = await refusal(run({ id: 9001, fullName: "player/vault" }));
    expect(err.code).toBe("APP_PERMISSIONS");
    expect(err.message).toMatch(/Workflows/);
    expect(await registry.vaultOf(4242)).toBeUndefined();
  });

  it("marks a vault whose commit failed, and finishes it on retry", async () => {
    const { gh, registry, run } = await setup();
    gh.beforeRefUpdate = async () => {
      throw new Error("network down");
    };
    await expect(run({ id: 9001, fullName: "player/vault" })).rejects.toThrow(/network down/);
    const failed = (await registry.vaultOf(4242))!;
    expect(failed).toMatchObject({ status: "disconnected", reason: "bootstrap_failed" });
    gh.beforeRefUpdate = undefined;
    const result = await run({ id: 9001, fullName: "player/vault" });
    expect(result.vault).toMatchObject({ id: failed.id, status: "ready" });
    expect(gh.at("player/vault").files()[".github/workflows/validate.yml"]).toBeDefined();
  });
});

describe("plan", () => {
  it("adopts vaults, initializes over starter files, refuses the rest", () => {
    expect(plan(["_hippo/config.yaml", "AGENTS.md"])).toEqual({ mode: "adopt", missing: ["CLAUDE.md", CURATOR_RULES_PATH, ".github/workflows/validate.yml"] });
    expect(plan(["README.md", ".gitignore", "LICENSE"])).toEqual({ mode: "initialize" });
    expect(plan(["README.md", "notes/today.md"])).toEqual({ mode: "refuse" });
  });
});
