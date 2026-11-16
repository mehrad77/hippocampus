import { describe, expect, it } from "vitest";
import type { HostedConnectedApp } from "@hippocampus/dashboard";
// The pretend hosted app's stages, so every one of them gets its steps checked.
import { DEMO_STAGES, hostedDemo, type HostedDemoStage } from "../../../../../packages/dashboard/src/demo-hosted.ts";
import { STEP_MAX_OUTPUT as CURATOR_MAX_OUTPUT } from "../../../../../packages/curator/src/pricing.ts";
import type { HostedRepoView, HostedStatus } from "../../lib/types.ts";
import {
  arrival,
  canAddVault,
  capProblems,
  connectionRows,
  curatorError,
  curatorProviders,
  ESTIMATE_ASSUMES,
  ESTIMATE_PROMPT_TOKENS,
  estimatePer100,
  hourOptions,
  isUniform,
  keyNeeded,
  localHour,
  modelsOf,
  money,
  pausedBanner,
  pauseWords,
  RUN_NOTHING_TO_DO,
  runCost,
  standbyWords,
  startingMix,
  STEP_MAX_OUTPUT,
  stopTone,
  uniformMix,
  freeHumans,
  humanIdFor,
  inviteProblem,
  draftProblems,
  draftReady,
  forNewVault,
  hostedDefaultStep,
  hostedIndex,
  hostedLock,
  hostedNeighbors,
  hostedProvider,
  hostedRepos,
  hostedStepDef,
  hostedStepState,
  identityFileName,
  identityFileText,
  initRequest,
  newDraft,
  outcomeTone,
  parseHostedStep,
  pickedAdoptable,
  preselectRepo,
  repoVerdict,
  resolveSetupHash,
  SETUP_SECTIONS,
  visibleSteps,
  type HostedContext,
} from "./hosted.ts";

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
const app = (extra: Partial<HostedConnectedApp> = {}): HostedConnectedApp => ({ id: "g1", client: "Claude", scopes: ["read", "remember", "goal"], vault: "v1", created: "2026-10-04T00:00:00Z", curate: false, mayCurate: true, ...extra });

describe("hosted onboarding steps", () => {
  it("has five steps, and shows Access only until the account is approved", () => {
    expect(visibleSteps(ctx(base)).map((s) => s.id)).toEqual(["access", "repo", "vault", "agent", "curate"]);
    expect(visibleSteps(ctx(approved)).map((s) => s.id)).toEqual(["repo", "vault", "agent", "curate"]);
    expect(visibleSteps(ctx({ ...base, account: { ...base.account, status: "denied" } })).map((s) => s.id)[0]).toBe("access");
    // Step numbers count what's shown.
    expect(hostedIndex("repo", visibleSteps(ctx(approved)))).toBe(0);
    expect(hostedNeighbors("repo", visibleSteps(ctx(approved)))).toEqual({ prev: undefined, next: expect.objectContaining({ id: "vault" }) });
  });

  it("starts on the waitlist, and everything past access is locked until approval", () => {
    expect(hostedDefaultStep(ctx(base))).toBe("access");
    expect(hostedStepState("access", ctx(base))).toBe("todo");
    expect(hostedStepState("access", ctx({ ...base, account: { ...base.account, requested: true } }))).toBe("wait");
    for (const id of ["repo", "vault", "agent", "curate"] as const) expect(hostedStepState(id, ctx(base))).toBe("locked");
  });

  it("walks an approved account through the repo (create, install, pick) and the vault", () => {
    expect(hostedDefaultStep(ctx(approved))).toBe("repo");
    expect(hostedLock("vault", ctx(approved))).toEqual(["Install the app on your repo first.", "Install the app on your repo first."]);
    expect(hostedDefaultStep(ctx(installed))).toBe("repo");
    expect(hostedStepState("repo", ctx(installed))).toBe("todo");
    expect(hostedLock("vault", ctx(installed))).toEqual(["Pick the repo first.", "Pick the repo first."]);
    expect(hostedStepState("repo", ctx(installed, { picked: 1 }))).toBe("done");
    expect(hostedDefaultStep(ctx(installed, { picked: 1 }))).toBe("vault");
    expect(hostedStepState("vault", ctx(installed, { picked: 1 }))).toBe("todo");
    // A repo the installation can no longer see doesn't count as picked.
    expect(hostedStepState("repo", ctx(installed, { picked: 99 }))).toBe("todo");
  });

  it("unlocks the agent and curation once the vault is ready", () => {
    expect(hostedStepState("agent", ctx(installed))).toBe("locked");
    expect(hostedDefaultStep(ctx(ready))).toBe("agent");
    const withAgent: HostedStatus = { ...ready, keys: [{ id: "a".repeat(64), kind: "agent", scopes: ["read"], label: "Agents", created: "2026-10-01T00:00:00Z" }] };
    expect(hostedStepState("agent", ctx(withAgent))).toBe("done");
    expect(hostedDefaultStep(ctx(withAgent))).toBe("curate");
    expect(hostedStepState("curate", ctx(withAgent))).toBe("todo");
    expect(hostedStepState("curate", ctx({ ...withAgent, curatorActions: true }))).toBe("done");
    // Hippocampus curating the vault with the owner's key counts; a saved key alone doesn't.
    const hosted = (enabled: boolean): HostedStatus => ({ ...withAgent, hostedCurator: { available: true, keyHint: "…3xQa", spentThisMonthUsd: 0, recommended: {}, models: [], vault: { enabled } } });
    expect(hostedStepState("curate", ctx(hosted(false)))).toBe("todo");
    expect(hostedStepState("curate", ctx(hosted(true)))).toBe("done");
    // A new vault's setup keeps the account's key and caps, not the shown vault's schedule.
    expect(forNewVault(hosted(true)).hostedCurator).toEqual({ available: true, keyHint: "…3xQa", spentThisMonthUsd: 0, recommended: {}, models: [] });
  });

  it("counts a sign-in app as the agent, and one that may curate as the curator", () => {
    expect(hostedStepState("agent", ctx(ready, { apps: [app()] }))).toBe("done");
    expect(hostedStepState("curate", ctx(ready, { apps: [app()] }))).toBe("todo");
    expect(hostedDefaultStep(ctx(ready, { apps: [app()] }))).toBe("curate");
    expect(hostedStepState("curate", ctx(ready, { apps: [app({ curate: true })] }))).toBe("done");
    // Another vault's grant counts for neither.
    expect(hostedStepState("agent", ctx(ready, { apps: [app({ vault: "v2", curate: true })] }))).toBe("todo");
    expect(hostedStepState("curate", ctx(ready, { apps: [app({ vault: "v2", curate: true })] }))).toBe("todo");
  });

  it("sends a disconnected vault back to the repo step", () => {
    const gone: HostedStatus = { ...approved, vault: { id: "v1", fullName: "player/lisbon-arc", branch: "main", status: "disconnected", reason: "uninstalled" } };
    expect(hostedDefaultStep(ctx(gone))).toBe("repo");
    expect(hostedStepState("repo", ctx(gone))).toBe("error");
    expect(hostedStepState("vault", ctx(gone))).toBe("locked");
    expect(hostedLock("vault", ctx(gone))).toEqual(["Install the app on your repo again first.", "Install the app on your repo again first."]);
  });

  it("waits on a vault being set up", () => {
    const busy: HostedStatus = { ...approved, vault: { id: "v1", fullName: "player/vault", branch: "main", status: "bootstrapping" } };
    expect(hostedDefaultStep(ctx(busy))).toBe("vault");
    expect(hostedStepState("vault", ctx(busy))).toBe("wait");
    expect(hostedStepState("repo", ctx(busy))).toBe("done");
  });
});

describe("setup page anchors", () => {
  const steps = (ready: boolean, adding = false) => (h: string) => resolveSetupHash(h, { ready, adding });

  it("keeps every old step id as an alias of its new step while setting up", () => {
    const at = steps(false);
    expect(at("#create")).toEqual({ step: "repo", alias: true });
    expect(at("#install")).toEqual({ step: "repo", alias: true });
    // Where the GitHub App install and GitLab connect send people back (SETUP_REPO): a step id of its own.
    expect(at("#repo")).toEqual({ step: "repo", alias: false });
    expect(at("#campaign")).toEqual({ step: "vault", alias: true });
    expect(at("#init")).toEqual({ step: "vault", alias: true });
    expect(at("#agents")).toEqual({ step: "agent", alias: true });
    expect(at("#curator")).toEqual({ step: "curate", alias: true });
    expect(at("#done")).toEqual({ step: "curate", alias: true });
    expect(at("#account")).toEqual({ anchor: "account", alias: false });
    expect(at("#personalization")).toEqual({ anchor: "personalization", alias: false });
    expect(at("")).toBeUndefined();
    expect(at("#somewhere")).toBeUndefined();
    expect(parseHostedStep("toString")).toBeUndefined();
  });

  it("sends old step hashes on a ready vault to their section, and keeps the section anchors", () => {
    const at = steps(true);
    expect(at("#curator")).toEqual({ anchor: "curation", alias: true });
    expect(at("#agents")).toEqual({ anchor: "setup-agents", alias: true });
    expect(at("#repo")).toEqual({ anchor: "sz-repo", alias: true });
    expect(at("#create")).toEqual({ anchor: "sz-repo", alias: true });
    expect(at("#init")).toEqual({ anchor: "sz-repo", alias: true });
    expect(at("#access")).toEqual({ anchor: "account", alias: true });
    expect(at("#done")).toEqual({ anchor: "setup-vault", alias: true });
    // The anchors in use: curationNote (#curation), CURATION_CONTROL (#connections), the SECTION map, the user menu and privacy notice.
    for (const a of ["curation", "connections", "account", "sz-repo", "secrets", "vaults", "people", "invite", "personalization", "setup-vault"]) expect(at(`#${a}`)).toEqual({ anchor: a, alias: false });
    // Steps 4 and 5 are still the wizard on a ready vault: init lands on #agent.
    expect(at("#agent")).toEqual({ step: "agent", alias: false });
    expect(at("#curate")).toEqual({ step: "curate", alias: false });
    expect(at("#vault")).toEqual({ step: "vault", alias: false });
  });

  it("keeps the add-a-vault flow's step hashes, beside a ready vault", () => {
    const at = steps(true, true);
    for (const h of ["create", "install", "repo"]) expect(at(`#${h}`)).toMatchObject({ step: "repo" });
    for (const h of ["campaign", "init", "vault"]) expect(at(`#${h}`)).toMatchObject({ step: "vault" });
  });

  it("has a section for each part of Setup & health, none named like an anchor inside it", () => {
    expect(SETUP_SECTIONS.map((s) => s.title[0])).toEqual(["Vault", "Agents", "Curation", "People", "Account"]);
    for (const s of SETUP_SECTIONS) expect(resolveSetupHash(`#${s.id}`, { ready: true })).toEqual({ anchor: s.id, alias: false });
    expect(SETUP_SECTIONS.map((s) => s.id)).not.toContain("curation");
  });
});

describe("every demo stage", () => {
  const source = { info: async () => ({ mode: "demo", vault: { kind: "memory" }, campaign: "lisbon-arc", human: "player", actor: { kind: "human", id: "player" } }) } as never;
  async function at(stage: HostedDemoStage, provider?: "gitlab") {
    const demo = hostedDemo({ base: "/dashboard", source, approveAfter: 0, initDelay: 0, firstCallAfter: 0, bootstrapFor: 60_000 });
    const get = async (path: string) => (await demo(new Request(`http://127.0.0.1/dashboard/api/${path}`)))!;
    await get(`__demo/stage?to=${stage}${provider ? `&provider=${provider}` : ""}`);
    const status = (await get("setup/status")).status === 200 ? ((await (await get("setup/status")).json()) as HostedStatus) : undefined;
    const apps = status?.vault?.status === "ready" ? ((await (await get("account/apps")).json()) as { apps: HostedConnectedApp[] }).apps : [];
    return { status, apps };
  }
  const expected: Record<HostedDemoStage, string | undefined> = {
    "signed-out": undefined,
    waitlisted: "access",
    requested: "access",
    denied: "access",
    fresh: "repo",
    approved: "repo",
    installed: "repo",
    disconnected: "repo",
    bootstrapping: "vault",
    ready: "curate",
  };

  it.each(DEMO_STAGES)("%s lands on its step", async (stage) => {
    const { status, apps } = await at(stage);
    if (!status) return expect(expected[stage]).toBeUndefined();
    const c = ctx(status, { apps });
    expect(hostedDefaultStep(c)).toBe(expected[stage]);
    // No step is ever stuck: the one landed on is never locked.
    expect(hostedStepState(hostedDefaultStep(c), c)).not.toBe("locked");
  });

  it("offers the disconnected vault's repo to reconnect, preselected", async () => {
    const { status } = await at("disconnected");
    // The picker's checked list says it holds a vault (the status lists repos unchecked).
    const repos: HostedRepoView[] = status!.installation!.repos.map((r) => (r.fullName === "player/lisbon-arc" ? { ...r, adoptable: true } : r));
    const c = ctx({ ...status!, installation: { ...status!.installation!, repos } });
    expect(preselectRepo(c)).toBe(502);
    expect(repoVerdict(hostedRepos(c).find((r) => r.id === 502)!)).toMatchObject({ tag: "Reconnect" });
    expect(pickedAdoptable({ ...c, picked: 502 })).toBe(true);
  });

  it("on GitLab: connected, an existing vault among the projects, and ready", async () => {
    const lab = await at("installed", "gitlab");
    expect(hostedProvider(ctx(lab.status!))).toBe("gitlab");
    expect(hostedDefaultStep(ctx(lab.status!))).toBe("repo");
    expect(hostedDefaultStep(ctx(lab.status!, { picked: 701 }))).toBe("vault");
    const done = await at("ready", "gitlab");
    expect(hostedDefaultStep(ctx(done.status!, { apps: done.apps }))).toBe("curate");
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

  it("unlocks the vault step once GitLab is connected and a project picked", () => {
    const c = ctx(offered, { provider: "gitlab" });
    expect(hostedLock("vault", c)).toEqual(["Connect GitLab first.", "Connect GitLab first."]);
    expect(hostedStepState("repo", c)).toBe("todo");
    const done = ctx(connected, { picked: 555 });
    expect(hostedRepos(done).map((r) => r.id)).toEqual([555]);
    expect(hostedStepState("repo", done)).toBe("done");
    expect(hostedDefaultStep(ctx(connected))).toBe("repo");
    expect(hostedLock("vault", ctx(connected))).toEqual(["Pick the project first.", "Pick the project first."]);
    expect(hostedDefaultStep(done)).toBe("vault");
    // The only project that can be the vault is preselected.
    expect(preselectRepo(ctx(connected))).toBe(555);
    // A project GitLab no longer lists doesn't count as picked, and neither does a GitHub repo's id.
    expect(hostedStepState("repo", ctx(connected, { picked: 1 }))).toBe("todo");
  });

  it("sends a revoked connection back to connecting", () => {
    const revoked: HostedStatus = { ...offered, gitlab: { ...offered.gitlab!, connected: false, login: "player", error: "GitLab no longer accepts the connection; connect it again." }, vault: { id: "v1", fullName: "player/vault", branch: "main", status: "disconnected", reason: "token_revoked", provider: "gitlab" } };
    expect(hostedDefaultStep(ctx(revoked))).toBe("repo");
    expect(hostedStepState("repo", ctx(revoked))).toBe("error");
    expect(hostedLock("vault", ctx(revoked))).toEqual(["Connect GitLab again first.", "Connect GitLab again first."]);
  });

  it("words the steps for GitLab", () => {
    expect(hostedStepDef("repo", "gitlab").title[0]).toBe("Project");
    expect(hostedStepDef("repo", "gitlab").lede[0]).toMatch(/GitLab project/);
    expect(hostedStepDef("agent", "gitlab")).toEqual(hostedStepDef("agent"));
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

  it("preselects only when there's no real choice", () => {
    const two: HostedStatus = { ...approved, installation: { id: 7, repos: [{ id: 1, fullName: "player/vault", private: true, empty: true }, { id: 2, fullName: "player/notes", private: false }] } };
    expect(preselectRepo(ctx(two))).toBe(1);
    const choice: HostedStatus = { ...two, installation: { id: 7, repos: [...two.installation!.repos, { id: 3, fullName: "player/other", private: true, empty: true }] } };
    expect(preselectRepo(ctx(choice))).toBeUndefined();
  });
});

describe("reconnecting a repo that already holds a vault", () => {
  const vault = { id: "v1", fullName: "player/lisbon-arc", branch: "main", status: "disconnected", reason: "uninstalled" } as const;
  const existing = { id: 1, fullName: "player/lisbon-arc", private: true, empty: false, adoptable: true };
  const fresh = { id: 2, fullName: "player/harbor-notes", private: true, empty: true };
  const reinstalled: HostedStatus = { ...approved, installation: { id: 8, repos: [existing, fresh] }, vault, vaults: [vault] };

  it("asks nothing in the vault step: an existing vault keeps its own settings", () => {
    const resume = ctx(reinstalled, { picked: 1 });
    expect(pickedAdoptable(resume)).toBe(true);
    expect(hostedLock("vault", resume)).toBeUndefined();
    expect(hostedStepState("vault", resume)).toBe("todo");
    expect(hostedDefaultStep(resume)).toBe("vault");
    // A new repo goes through the name, and nothing picked means nothing adopted.
    const created = ctx(reinstalled, { picked: 2 });
    expect(pickedAdoptable(created)).toBe(false);
    expect(hostedStepState("vault", created)).toBe("error");
    expect(pickedAdoptable(ctx(reinstalled))).toBe(false);
    // The disconnected vault's own repo is the one preselected.
    expect(preselectRepo(ctx(reinstalled))).toBe(1);
  });

  it("offers a disconnected vault's repo again, while a connected one stays taken", () => {
    const [repo] = hostedRepos(ctx(reinstalled));
    expect(repo).toMatchObject({ id: 1, reconnect: true });
    expect(repo!.yours).toBeUndefined();
    expect(repoVerdict(repo!)).toMatchObject({ usable: true, tag: "Reconnect" });
    const connected: HostedStatus = { ...reinstalled, vault: { ...vault, status: "ready" }, vaults: [{ ...vault, status: "ready" }] };
    const [taken] = hostedRepos(ctx(connected));
    expect(taken).toMatchObject({ id: 1, yours: true });
    expect(repoVerdict(taken!)).toMatchObject({ usable: false, tag: "Already yours" });
  });

  it("sends only the repo, so nothing from the form can overwrite the vault's settings", () => {
    const draft = { ...newDraft("Europe/Lisbon"), campaign: "Lisbon Arc", seed: true, presets: ["people"] };
    expect(initRequest(draft, 1, { adopt: true })).toEqual({ repoId: 1, adopt: true });
    expect(initRequest(draft, 1, { adopt: true, provider: "gitlab" })).toEqual({ provider: "gitlab", repoId: 1, adopt: true });
    // A key made and saved before picking the vault still goes along; the vault keeps its own if it has one.
    const key = "age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs3290gq";
    expect(initRequest({ ...draft, recipient: key, saved: true }, 1, { adopt: true })).toEqual({ repoId: 1, adopt: true, recipient: key });
    expect(initRequest({ ...draft, recipient: key }, 1, { adopt: true })).not.toHaveProperty("recipient");
    expect(initRequest(draft, 2)).toMatchObject({ repoId: 2, campaign: "Lisbon Arc", seed: "example-relocation", presets: ["people"] });
    expect(initRequest(draft, 2)).not.toHaveProperty("adopt");
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
    expect(hostedStepState("agent", ctx(fresh))).toBe("locked");
  });

  it("marks repos that are vaults already, and refuses them", () => {
    const repos = hostedRepos(ctx(forNewVault(two)));
    expect(repos.map((r) => [r.fullName, !!r.yours])).toEqual([
      ["player/lisbon-arc", true],
      ["player/harbor-notes", false],
    ]);
    expect(repoVerdict(repos[0]!)).toMatchObject({ usable: false, tag: "Already yours" });
    expect(preselectRepo(ctx(forNewVault(two)))).toBe(2);
  });

  it("stops at the limit, and before approval", () => {
    expect(canAddVault(two)).toEqual({ ok: true });
    expect(canAddVault({ ...two, vaults: [ready.vault!, ready.vault!] })).toMatchObject({ ok: false, why: expect.stringContaining("2 vaults") });
    expect(canAddVault(base).ok).toBe(false);
    // Vaults shared with them don't count.
    expect(canAddVault({ ...two, vaults: [ready.vault!, { ...ready.vault!, id: "v2", role: "member" }] })).toEqual({ ok: true });
  });
});

describe("the vault draft", () => {
  it("needs only a name: your id comes from your login, and the key never blocks", () => {
    const d = { ...newDraft("Europe/Lisbon", "Player_One"), campaign: "Lisbon Arc" };
    expect(d.human).toBe("player-one");
    expect(newDraft("UTC").human).toBe("player");
    expect(d.secrets).toBe("create");
    expect(draftReady(d)).toBe(true);
    expect(draftReady({ ...d, campaign: " " })).toBe(false);
    expect(draftReady({ ...d, recipient: "age1example", saved: false })).toBe(true);
    expect(draftProblems({ ...d, human: "Player" }).human).toBeDefined();
    expect(draftProblems({ ...d, timezone: "Mars/Olympus" }).timezone).toBeDefined();
  });

  it("sends the public key only once its file is saved, and the seed only when asked", () => {
    const d = { ...newDraft("Europe/Lisbon"), campaign: " Lisbon Arc ", recipient: "age1example", saved: true };
    expect(initRequest(d, 1)).toEqual({ repoId: 1, campaign: "Lisbon Arc", human: "player", timezone: "Europe/Lisbon", domains: ["admin", "housing", "career", "finance", "health", "story"], recipient: "age1example" });
    // A key whose file wasn't saved would lock secrets nobody can read: the vault starts without it.
    expect(initRequest({ ...d, saved: false }, 1)).not.toHaveProperty("recipient");
    expect(initRequest({ ...d, seed: true, secrets: "skip" }, 1)).toMatchObject({ seed: "example-relocation" });
    expect(initRequest({ ...d, presets: ["people", "student"] }, 1)).toMatchObject({ presets: ["people", "student"] });
    // An existing vault is adopted as it is.
    expect(initRequest({ ...d, presets: ["people"] }, 1, { adopt: true })).not.toHaveProperty("presets");
    expect(initRequest({ ...d, secrets: "skip" }, 1)).not.toHaveProperty("recipient");
  });

  it("names the key file after the vault and writes only the identity", () => {
    expect(identityFileName("Lisbon Arc")).toBe("hippocampus-lisbon-arc.agekey");
    expect(identityFileName("Ação!")).toBe("hippocampus-acao.agekey");
    expect(identityFileName("")).toBe("hippocampus-vault.agekey");
    expect(identityFileText("AGE-SECRET-KEY-1EXAMPLE \n")).toBe("AGE-SECRET-KEY-1EXAMPLE\n");
  });
});

describe("an agent arriving", () => {
  const key = (id: string, extra: object = {}) => ({ id, kind: "agent" as const, scopes: ["read", "remember", "goal"], label: "Claude Code", created: "2026-10-01T00:00:00Z", ...extra });

  it("waits, then sees the connection approved, then its first call and the agent's name", () => {
    const before = new Set(["old"]);
    expect(arrival(connectionRows([key("old", { lastUsed: "2026-10-01T01:00:00Z" })], [], "v1"), before)).toEqual({ state: "waiting" });
    expect(arrival(connectionRows([key("old"), key("new")], [], "v1"), before)).toEqual({ state: "approved", name: "Claude Code" });
    const called = connectionRows([key("new", { lastUsed: "2026-10-02T00:00:00Z" })], [], "v1", [{ agent: "claude-code-home-finder", credential: "key:new", since: "2026-10-02T00:00:00Z" }]);
    expect(arrival(called, before)).toEqual({ state: "connected", name: "Claude Code", agent: "claude-code-home-finder" });
  });

  it("counts a sign-in app at once, and never the curator's own connection", () => {
    expect(arrival(connectionRows([], [app({ agent: "claude-web" })], "v1"), new Set())).toEqual({ state: "connected", name: "Claude", agent: "claude-web" });
    expect(arrival(connectionRows([{ ...key("c"), kind: "curator", scopes: ["read", "curate"], lastUsed: "2026-10-02T00:00:00Z" }], [], "v1"), new Set())).toEqual({ state: "waiting" });
  });
});

describe("sharing", () => {
  it("offers the humans nobody holds yet, never the inviter's own", () => {
    expect(freeHumans(["player", "flatmate", "game-master"], [{}, { human: "game-master" }], "player")).toEqual(["flatmate"]);
  });

  it("turns a login into a human id, and checks the invite form", () => {
    expect(humanIdFor("Game_Master")).toBe("game-master");
    expect(inviteProblem({ login: "@game-master", human: "game-master" })).toBeUndefined();
    expect(inviteProblem({ login: "", human: "game-master" })).toBeUndefined();
    expect(inviteProblem({ login: "not a login", human: "game-master" })).toMatch(/GitHub username/);
    expect(inviteProblem({ login: "", human: "Game Master" })).toMatch(/lowercase/);
  });
});

describe("connections", () => {
  it("lists keys and this vault's sign-in apps together, in plain words", () => {
    const rows = connectionRows(
      [
        { id: "k1", kind: "bound", agent: "claude-code", scopes: ["read", "remember", "goal"], label: "Claude Code", created: "2026-10-01T00:00:00Z", lastUsed: "2026-10-02T00:00:00Z" },
        { id: "k2", kind: "agent", scopes: ["read", "remember", "goal"], label: "Cursor", app: "cursor", created: "2026-10-03T00:00:00Z" },
        { id: "k3", kind: "curator", scopes: ["read", "curate"], label: "Curator", created: "2026-09-30T00:00:00Z" },
      ],
      [
        { id: "g1", client: "Claude", scopes: ["read"], agent: "claude-web", vault: "v1", created: "2026-10-04T00:00:00Z", curate: false, mayCurate: false },
        { id: "g2", client: "ChatGPT", scopes: ["read"], agent: "chatgpt", vault: "v2", created: "2026-10-05T00:00:00Z", curate: false, mayCurate: false },
      ],
      "v1",
      [
        { agent: "cursor-home-finder", credential: "key:k2", since: "2026-10-03T10:00:00Z" },
        { agent: "cursor-job-scout", credential: "key:k2", since: "2026-10-03T11:00:00Z" },
        { agent: "someone-elses", credential: "key:other", since: "2026-10-03T12:00:00Z" },
        { agent: "chatgpt-planner", credential: "oauth:g1", since: "2026-10-04T10:00:00Z" },
      ],
    );
    expect(rows.map((r) => [r.name, r.kind, r.can, r.actsAs])).toEqual([
      ["Claude", "sign-in app", "Only look things up", { agent: "claude-web" }],
      ["Cursor", "shared key", "Remember and recall", { shared: true }],
      ["Claude Code", "single-agent key", "Remember and recall", { agent: "claude-code" }],
      ["Curator", "curator key", "Curate nightly", { curator: true }],
    ]);
    // A shared connection shows who has spoken through it: by key id, or by sign-in grant.
    expect(rows.find((r) => r.id === "k2")!.agents.map((a) => a.agent)).toEqual(["cursor-home-finder", "cursor-job-scout"]);
    expect(rows.find((r) => r.id === "g1")!.agents.map((a) => a.agent)).toEqual(["chatgpt-planner"]);
    expect(rows.find((r) => r.id === "k1")!.agents).toEqual([]);
  });

  it("counts an app's curating only while its switch is on, and offers the switch to an owner", () => {
    const app = { id: "g3", client: "Claude", scopes: ["read", "remember", "goal", "curate"], vault: "v1", created: "2026-10-06T00:00:00Z", mayCurate: true };
    const [off] = connectionRows([], [{ ...app, curate: false }], "v1");
    expect(off).toMatchObject({ actsAs: { shared: true }, can: "Remember and recall", curating: { may: true, on: false } });
    expect(off!.scopes).not.toContain("curate");
    const [on] = connectionRows([], [{ ...app, curate: true }], "v1");
    expect(on).toMatchObject({ actsAs: { curator: true }, curating: { may: true, on: true } });
    expect(on!.scopes).toContain("curate");
    // A member sees the app, but not the switch.
    expect(connectionRows([], [{ ...app, curate: true, mayCurate: false }], "v1")[0]!.curating).toBeUndefined();
  });
});

describe("hosted curation", () => {
  const models = [
    { provider: "anthropic" as const, model: "claude-sonnet-5-5", inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
    { provider: "anthropic" as const, model: "claude-haiku-5-5", inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5 },
    { provider: "mistral" as const, model: "mistral-small-2603", inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.6 },
  ];
  const rec = { mentions: "claude-haiku-5-5", match: "claude-haiku-5-5", claims: "claude-sonnet-5-5", summary: "claude-haiku-5-5" };
  const status = { recommended: { anthropic: rec }, models };

  it("starts from the saved mix, then the eval's, then the provider's cheapest model for every step", () => {
    expect(startingMix(status, "anthropic")).toEqual({ mix: rec, recommended: true });
    expect(startingMix(status, "mistral")).toEqual({ mix: uniformMix("mistral-small-2603"), recommended: false });
    expect(startingMix({ ...status, provider: "anthropic", steps: uniformMix("claude-sonnet-5-5") }, "anthropic")).toEqual({ mix: uniformMix("claude-sonnet-5-5"), recommended: false });
    expect(startingMix({ recommended: {}, models: [] }, "anthropic")).toBeUndefined();
    expect(modelsOf(models, "anthropic").map((m) => m.model)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
    expect(curatorProviders(models)).toEqual(["anthropic", "mistral"]);
    expect(isUniform(rec)).toBe(false);
  });

  it("estimates 100 memories high: one call per step, a full prompt, and every output token allowed", () => {
    // Haiku: 4 calls × 4,000 tokens × $0.1/M, plus 7,680 output tokens × $0.5/M = $0.00544 a memory.
    expect(estimatePer100(uniformMix("claude-haiku-5-5"), models, "anthropic")).toBeCloseTo(0.544, 6);
    const per = (step: keyof typeof STEP_MAX_OUTPUT, input: number, output: number) => (ESTIMATE_PROMPT_TOKENS * input + STEP_MAX_OUTPUT[step] * output) / 1e6;
    expect(estimatePer100(rec, models, "anthropic")).toBeCloseTo(100 * (per("mentions", 0.1, 0.5) + per("match", 0.1, 0.5) + per("claims", 2, 10) + per("summary", 0.1, 0.5)), 6);
    // A model without a price gives no estimate.
    expect(estimatePer100(uniformMix("unknown"), models, "anthropic")).toBeUndefined();
    // The dashboard's copy of the curator's output allowance stays equal to it.
    expect(STEP_MAX_OUTPUT).toEqual(CURATOR_MAX_OUTPUT);
    expect(ESTIMATE_ASSUMES).toMatch(/4,000 tokens/);
    expect([money(0.544), money(0.004), money(0), money(1234.5)]).toEqual(["$0.54", "under $0.01", "$0.00", "$1,235"]);
  });

  it("checks the caps and asks for a key on the first save and with a new provider", () => {
    expect(capProblems({ month: "10", run: "2" })).toEqual({ month: undefined, run: undefined });
    expect(capProblems({ month: "", run: "0" })).toEqual({ month: "A number of US dollars.", run: "More than $0." });
    expect(capProblems({ month: "5", run: "6" }).run).toBe("At most the monthly cap.");
    expect(capProblems({ month: "20000", run: "1" }).month).toBe("Up to $10,000.");
    expect(keyNeeded({}, "anthropic")).toBe(true);
    expect(keyNeeded({ provider: "anthropic", keyHint: "…3xQa" }, "anthropic")).toBe(false);
    expect(keyNeeded({ provider: "anthropic", keyHint: "…3xQa" }, "mistral")).toBe(true);
  });

  it("offers the 24 UTC hours, labelled in the person's own time", () => {
    const at = new Date("2026-11-16T12:00:00Z");
    const lisbon = hourOptions(at, "Europe/Lisbon");
    expect(lisbon).toHaveLength(24);
    expect(lisbon[0]).toEqual({ hourUtc: 0, label: "00:00" });
    expect(localHour(3, at, "Europe/Berlin")).toBe("04:00");
    // A half-hour zone says so, rather than rounding the hour.
    expect(hourOptions(at, "Asia/Kolkata").find((o) => o.hourUtc === 21)!.label).toBe("02:30");
    expect(new Set(hourOptions(at, "Asia/Kolkata").map((o) => o.hourUtc)).size).toBe(24);
  });

  it("says why runs wait and what fixes it, and who stands by", () => {
    expect(pausedBanner({ reason: "budget" }, { curator: "archivist", at: "2026-11-15T03:00:00Z", decision: "needed" })).toEqual({
      head: "Paused: monthly budget reached",
      standby: "archivist",
      fix: expect.stringMatching(/Raise the monthly cap/),
    });
    expect(pausedBanner({ reason: "auth" }, undefined).standby).toBeUndefined();
    expect(pausedBanner({ reason: "auth" }, undefined).fix).toMatch(/Save a new key/);
    expect(pausedBanner({ reason: "credit" }, undefined).fix).toMatch(/credit/);
    expect(pauseWords("toString").word).toBe("Paused");
    expect(standbyWords({ curator: "archivist", at: "2026-11-15T03:00:00Z", decision: "hosted" })).toEqual({ curator: "archivist", at: "2026-11-15T03:00:00Z", decision: "Hippocampus had it covered" });
    expect(standbyWords(undefined)).toBeUndefined();
  });

  it("puts the route codes in plain words, and keeps the server's own for the rest", () => {
    expect(curatorError({ status: 400, code: "KEY_AUTH", message: "x" })).toMatchObject({ code: "KEY_AUTH", message: expect.stringMatching(/refused that key/) });
    expect(curatorError({ status: 409, code: "BUDGET", message: "x" })).toMatchObject({ message: expect.stringMatching(/Raise the monthly cap/) });
    const missing = { status: 400, code: "KEY_MODELS_MISSING", message: "This key can't use claude-opus-5-5." };
    expect(curatorError(missing)).toBe(missing);
    expect(curatorError({ code: "toString", message: "y" })).toMatchObject({ message: "y" });
    expect(RUN_NOTHING_TO_DO.has("IDLE") && RUN_NOTHING_TO_DO.has("NOT_NEEDED")).toBe(true);
  });

  it("names why a run stopped, and shows a stop it doesn't know as itself", () => {
    expect(stopTone("budget")).toMatchObject({ tone: "warn", word: "Paused at the budget" });
    expect(stopTone("auth").word).toBe("Key refused");
    expect(stopTone("credit").word).toBe("Out of credit");
    expect(stopTone("constructor").word).toBe("Stopped: constructor");
    expect(runCost({ micros: 420_000, calls: 28 })).toEqual({ usd: 0.42, calls: 28 });
    expect(runCost(undefined)).toBeUndefined();
  });
});

describe("outcomeTone", () => {
  it("names the known outcomes, and shows one it doesn't know as itself", () => {
    expect(outcomeTone("done")).toMatchObject({ tone: "done", word: "Finished" });
    expect(outcomeTone("aborted").tone).toBe("error");
    expect(outcomeTone("stopped")).toMatchObject({ tone: "na", word: "stopped" });
    expect(outcomeTone("toString").word).toBe("toString");
    expect(outcomeTone("").word).toBe("Unknown");
  });
});
