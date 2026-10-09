import { describe, expect, it } from "vitest";
import type { HostedStatus } from "../../lib/types.ts";
import { draftProblems, draftReady, hostedDefaultStep, hostedLock, hostedStepState, identityFileName, identityFileText, initRequest, newDraft, repoVerdict, type HostedContext } from "./hosted.ts";

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
    expect(initRequest({ ...d, secrets: "skip" }, 1)).not.toHaveProperty("recipient");
  });

  it("names the key file after the campaign and writes only the identity", () => {
    expect(identityFileName("Lisbon Arc")).toBe("hippocampus-lisbon-arc.agekey");
    expect(identityFileName("Ação!")).toBe("hippocampus-acao.agekey");
    expect(identityFileName("")).toBe("hippocampus-vault.agekey");
    expect(identityFileText("AGE-SECRET-KEY-1EXAMPLE \n")).toBe("AGE-SECRET-KEY-1EXAMPLE\n");
  });
});
