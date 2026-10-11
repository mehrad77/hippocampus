import { describe, expect, it } from "vitest";
import type { HostedStatus } from "../../lib/types.ts";
import { canAddVault, draftProblems, draftReady, forNewVault, hostedDefaultStep, hostedLock, hostedProvider, hostedRepos, hostedStepDef, hostedStepState, identityFileName, identityFileText, initRequest, newDraft, repoVerdict, type HostedContext } from "./hosted.ts";

const base: HostedStatus = {
  kind: "hosted",
  account: { login: "player", status: "waitlisted", requested: false, admin: false },
  installUrl: "https://github.example/apps/hippocampus/installations/new",
  newRepoUrl: "https://github.example/new",
  publicUrl: "https://hippo.example",
  mcpUrl: "https://hippo.example/mcp",
  items: [],
};
const approved: HostedStatus = { ...base, account: { ...base.account, status: "approved", requested: true } };
const installed: HostedStatus = { ...approved, installation: { id: 7, repos: [{ id: 1, fullName: "player/lisbon-arc", private: true }] } };
const ready: HostedStatus = { ...approved, vault: { id: "v1", fullName: "player/lisbon-arc", branch: "main", status: "ready" } };
const ctx = (status: HostedStatus, extra: Partial<HostedContext> = {}): HostedContext => ({ status, draftReady: false, ...extra });

describe("hosted onboarding steps", () => {
  it("starts on the waitlist, and everything past access is locked until approval", () => {
    expect(hostedDefaultStep(ctx(base))).toBe("access");
    expect(hostedStepState("access", ctx(base))).toBe("todo");
    expect(hostedStepState("access", ctx({ ...base, account: { ...base.account, requested: true } }))).toBe("wait");
    for (const id of ["create", "install", "repo", "campaign", "init", "agents", "curator", "done"] as const) expect(hostedStepState(id, ctx(base))).toBe("locked");
  });

  it("walks an approved account through create, install, pick, name and set up", () => {
    expect(hostedDefaultStep(ctx(approved))).toBe("create");
    expect(hostedLock("repo", ctx(approved))).toBeDefined();
    expect(hostedStepState("campaign", ctx(approved))).toBe("todo");
    expect(hostedDefaultStep(ctx(installed))).toBe("repo");
    expect(hostedStepState("install", ctx(installed))).toBe("done");
    expect(hostedStepState("init", ctx(installed, { picked: 1 }))).toBe("locked");
    expect(hostedDefaultStep(ctx(installed, { picked: 1 }))).toBe("campaign");
    expect(hostedDefaultStep(ctx(installed, { picked: 1, draftReady: true }))).toBe("init");
    expect(hostedStepState("init", ctx(installed, { picked: 1, draftReady: true }))).toBe("todo");
    // A repo the installation can no longer see doesn't count as picked.
    expect(hostedStepState("repo", ctx(installed, { picked: 99 }))).toBe("todo");
  });

  it("unlocks agents and the curator once the vault is ready", () => {
    expect(hostedStepState("agents", ctx(installed))).toBe("locked");
    expect(hostedDefaultStep(ctx(ready))).toBe("agents");
    const withAgent: HostedStatus = { ...ready, keys: [{ id: "a".repeat(64), kind: "agent", scopes: ["read"], label: "Agents", created: "2026-10-01T00:00:00Z" }] };
    expect(hostedStepState("agents", ctx(withAgent))).toBe("done");
    expect(hostedDefaultStep(ctx(withAgent))).toBe("curator");
    expect(hostedDefaultStep(ctx({ ...withAgent, curatorActions: true }))).toBe("done");
  });

  it("sends a disconnected vault back to installing the app", () => {
    const gone: HostedStatus = { ...approved, vault: { id: "v1", fullName: "player/lisbon-arc", branch: "main", status: "disconnected", reason: "uninstalled" } };
    expect(hostedDefaultStep(ctx(gone))).toBe("install");
    expect(hostedStepState("install", ctx(gone))).toBe("error");
    expect(hostedStepState("init", ctx(gone))).toBe("locked");
  });
});

describe("hosted onboarding on GitLab", () => {
  const offered: HostedStatus = { ...approved, providers: ["github", "gitlab"], gitlab: { connected: false, connectUrl: "/dashboard/setup/gitlab/connect", newRepoUrl: "https://gitlab.example/projects/new" } };
  const connected: HostedStatus = { ...offered, gitlab: { ...offered.gitlab!, connected: true, login: "player", repos: [{ id: 555, fullName: "player/vault", private: true, empty: true }] } };

  it("is GitHub unless the instance offers GitLab", () => {
    expect(hostedProvider(ctx(approved, { provider: "gitlab" }))).toBe("github");
    expect(hostedProvider(ctx(offered))).toBe("github");
    expect(hostedProvider(ctx(offered, { provider: "gitlab" }))).toBe("gitlab");
  });

  it("follows the connection, then the vault, over the choice", () => {
    expect(hostedProvider(ctx(connected))).toBe("gitlab");
    expect(hostedProvider(ctx({ ...connected, installation: { id: 7, repos: [] } }))).toBe("github");
    const onGitHub: HostedStatus = { ...connected, vault: { id: "v1", fullName: "player/vault", branch: "main", status: "ready", provider: "github" } };
    expect(hostedProvider(ctx(onGitHub, { provider: "gitlab" }))).toBe("github");
  });

  it("unlocks the repo step once GitLab is connected, and picks from its projects", () => {
    const c = ctx(offered, { provider: "gitlab" });
    expect(hostedLock("repo", c)).toEqual(["Connect GitLab first.", "Connect GitLab first."]);
    expect(hostedStepState("install", c)).toBe("todo");
    const done = ctx(connected, { picked: 555 });
    expect(hostedRepos(done).map((r) => r.id)).toEqual([555]);
    expect(hostedStepState("install", done)).toBe("done");
    expect(hostedStepState("create", done)).toBe("done");
    expect(hostedDefaultStep(ctx(connected))).toBe("repo");
    expect(hostedDefaultStep(done)).toBe("campaign");
    expect(hostedDefaultStep({ ...done, draftReady: true })).toBe("init");
    // A project GitLab no longer lists doesn't count as picked, and neither does a GitHub repo's id.
    expect(hostedStepState("repo", ctx(connected, { picked: 1 }))).toBe("todo");
  });

  it("sends a revoked connection back to connecting", () => {
    const revoked: HostedStatus = { ...offered, gitlab: { ...offered.gitlab!, connected: false, login: "player", error: "GitLab no longer accepts the connection; connect it again." }, vault: { id: "v1", fullName: "player/vault", branch: "main", status: "disconnected", reason: "token_revoked", provider: "gitlab" } };
    expect(hostedDefaultStep(ctx(revoked))).toBe("install");
    expect(hostedStepState("install", ctx(revoked))).toBe("error");
    expect(hostedLock("repo", ctx(revoked))).toEqual(["Connect GitLab again first.", "Connect GitLab again first."]);
  });

  it("words the steps for GitLab", () => {
    expect(hostedStepDef("install", "gitlab").title[0]).toBe("Connect GitLab");
    expect(hostedStepDef("create", "gitlab").lede[0]).toMatch(/GitLab project/);
    expect(hostedStepDef("agents", "gitlab")).toEqual(hostedStepDef("agents"));
  });

  it("asks for the provider only when it is GitLab", () => {
    const draft = { ...newDraft("Europe/Lisbon"), campaign: "Lisbon Arc", secrets: "skip" as const };
    expect(initRequest(draft, 555, { provider: "gitlab" })).toMatchObject({ provider: "gitlab", repoId: 555 });
    expect(initRequest(draft, 1)).not.toHaveProperty("provider");
  });

  it("calls an internal project not private", () => {
    expect(repoVerdict({ id: 555, fullName: "player/vault", private: false }, "gitlab")).toMatchObject({ usable: false, tag: "Not private" });
    expect(repoVerdict({ id: 555, fullName: "player/vault", private: false }, "gitlab").detail).toMatch(/internal/);
    expect(repoVerdict({ id: 555, fullName: "player/vault", private: true, empty: true }, "gitlab")).toMatchObject({ usable: true, tag: "Empty" });
  });
});

describe("repo picker", () => {
  it("refuses public repos and says why", () => {
    expect(repoVerdict({ id: 1, fullName: "player/notes", private: false })).toMatchObject({ usable: false, tag: "Public" });
  });

  it("prefers empty repos and labels existing vaults", () => {
    expect(repoVerdict({ id: 1, fullName: "player/vault", private: true, empty: true })).toMatchObject({ usable: true, tone: "done", tag: "Empty" });
    expect(repoVerdict({ id: 2, fullName: "player/old-arc", private: true, empty: false, adoptable: true })).toMatchObject({ usable: true, tag: "Existing vault" });
    expect(repoVerdict({ id: 3, fullName: "player/dotfiles", private: true, empty: false, adoptable: false })).toMatchObject({ usable: false, tag: "Has files" });
    expect(repoVerdict({ id: 4, fullName: "player/maybe", private: true, empty: false })).toMatchObject({ usable: true, tone: "warn" });
    expect(repoVerdict({ id: 5, fullName: "player/unchecked", private: true })).toMatchObject({ usable: true, tag: "Not checked" });
  });
});

describe("adding another vault", () => {
  const two: HostedStatus = {
    ...ready,
    installation: { id: 7, repos: [{ id: 1, fullName: "player/lisbon-arc", private: true }, { id: 2, fullName: "player/harbor-notes", private: true, empty: true }] },
    vaults: [ready.vault!],
    vaultLimit: 2,
    keys: [{ id: "k", kind: "agent", scopes: ["read"], label: "Any agent", created: "2026-10-01T00:00:00Z" }],
    items: [
      { id: "access", title: "Access", state: "done", detail: "approved", how: "performed" },
      { id: "keys", title: "Agent keys", state: "done", detail: "1 key", how: "performed" },
    ],
  };

  it("starts the wizard fresh beside a ready vault, at the repo picker", () => {
    const fresh = forNewVault(two);
    expect(fresh.vault).toBeUndefined();
    expect(fresh.keys).toBeUndefined();
    expect(fresh.items.map((i) => i.id)).toEqual(["access"]);
    expect(hostedDefaultStep(ctx(fresh))).toBe("repo");
    expect(hostedStepState("agents", ctx(fresh))).toBe("locked");
  });

  it("marks repos that are vaults already, and refuses them", () => {
    const repos = hostedRepos(ctx(forNewVault(two)));
    expect(repos.map((r) => [r.fullName, !!r.yours])).toEqual([
      ["player/lisbon-arc", true],
      ["player/harbor-notes", false],
    ]);
    expect(repoVerdict(repos[0]!)).toMatchObject({ usable: false, tag: "Already yours" });
  });

  it("stops at the limit, and before approval", () => {
    expect(canAddVault(two)).toEqual({ ok: true });
    expect(canAddVault({ ...two, vaults: [ready.vault!, ready.vault!] })).toMatchObject({ ok: false, why: expect.stringContaining("2 vaults") });
    expect(canAddVault(base).ok).toBe(false);
  });
});

describe("campaign draft", () => {
  it("needs a name, a valid id and zone, and a saved key unless skipped", () => {
    const d = { ...newDraft("Europe/Lisbon"), campaign: "Lisbon Arc" };
    expect(draftProblems(d).secrets).toMatch(/key/);
    expect(draftReady({ ...d, secrets: "skip" })).toBe(true);
    expect(draftReady({ ...d, recipient: "age1example", saved: false })).toBe(false);
    expect(draftReady({ ...d, recipient: "age1example", saved: true })).toBe(true);
    expect(draftProblems({ ...d, human: "Player" }).human).toBeDefined();
    expect(draftProblems({ ...d, timezone: "Mars/Olympus" }).timezone).toBeDefined();
  });

  it("sends only the public key, and the seed only when asked", () => {
    const d = { ...newDraft("Europe/Lisbon"), campaign: " Lisbon Arc ", recipient: "age1example", saved: true };
    expect(initRequest(d, 1)).toEqual({ repoId: 1, campaign: "Lisbon Arc", human: "player", timezone: "Europe/Lisbon", domains: ["admin", "housing", "career", "finance", "health", "story"], recipient: "age1example" });
    expect(initRequest({ ...d, seed: true, secrets: "skip" }, 1)).toMatchObject({ seed: "example-relocation" });
    expect(initRequest({ ...d, presets: ["people", "student"] }, 1)).toMatchObject({ presets: ["people", "student"] });
    // An existing vault is adopted as it is.
    expect(initRequest({ ...d, presets: ["people"] }, 1, { adopt: true })).not.toHaveProperty("presets");
    expect(initRequest({ ...d, secrets: "skip" }, 1)).not.toHaveProperty("recipient");
  });

  it("names the key file after the campaign and writes only the identity", () => {
    expect(identityFileName("Lisbon Arc")).toBe("hippocampus-lisbon-arc.agekey");
    expect(identityFileName("Ação!")).toBe("hippocampus-acao.agekey");
    expect(identityFileName("")).toBe("hippocampus-vault.agekey");
    expect(identityFileText("AGE-SECRET-KEY-1EXAMPLE \n")).toBe("AGE-SECRET-KEY-1EXAMPLE\n");
  });
});
