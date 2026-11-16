import type { HostedCuratorActionsState, HostedNewInvite, HostedSetupStatus } from "@hippocampus/dashboard";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { PLAYER, hostedApp } from "../testing/hosted-app.ts";
import { SLEEP_WORKFLOW, SLEEP_WORKFLOW_PATH, sleepWorkflow } from "./curator-actions.ts";
import { sealNonce } from "./sealed-box.ts";
import { EXAMPLE_MCP_URL, bakedMcpUrl, bakedModel } from "./sleep-workflow.ts";

describe("the GitHub Actions curator", () => {
  it("writes the workflow with the app's own commit, and removes it", async () => {
    const h = await hostedApp();
    const { visit } = await h.readyAccount(PLAYER);
    const repo = h.gh.at("player/vault");
    const status = async () => (await (await h.api(visit, "setup/status")).json()) as HostedSetupStatus;
    expect((await status()).curatorActions).toBe(false);
    expect((await status()).items).toContainEqual(expect.objectContaining({ id: "curator", state: "optional" }));

    expect((await h.post(visit, "setup/curator-actions", { enable: "yes" })).status).toBe(400);
    expect((await h.post(visit, "setup/curator-actions", { enable: true }, {})).status).toBe(403);
    expect((await h.post(visit, "setup/curator-actions", { enable: true, model: "haiku" })).status).toBe(400);
    const on = await h.post(visit, "setup/curator-actions", { enable: true });
    expect(await on.json()).toEqual({ enabled: true, path: SLEEP_WORKFLOW_PATH, model: "sonnet" });
    // The vault's own address and the default model, baked in.
    const { mcpUrl } = await status();
    expect(repo.files()[SLEEP_WORKFLOW_PATH]).toBe(sleepWorkflow({ mcpUrl, model: "sonnet" }));
    expect(repo.log()[0]!.message).toBe("chore: run sleep nightly on GitHub Actions [skip ci]\n\nHippo-Actor: bootstrap");
    // GitHub refuses workflow files from a token without `workflows: write`; the one used had it, for this repo only.
    expect([...h.gh.tokens.values()].some((t) => t.permissions?.workflows === "write" && t.repos?.join() === "player/vault")).toBe(true);
    expect(await status()).toMatchObject({ curatorActions: true, items: expect.arrayContaining([expect.objectContaining({ id: "curator", state: "done" })]) });

    // Already there: nothing to commit.
    const first = repo.log().length;
    await h.post(visit, "setup/curator-actions", { enable: true });
    expect(repo.log()).toHaveLength(first);

    // Another model: one commit, and turning it on again keeps that model.
    expect(await (await h.post(visit, "setup/curator-actions", { enable: true, model: "opus" })).json()).toMatchObject({ model: "opus" });
    expect(repo.files()[SLEEP_WORKFLOW_PATH]).toBe(sleepWorkflow({ mcpUrl, model: "opus" }));
    expect(repo.log()[0]!.message).toMatch(/^chore: update the nightly sleep workflow/);
    expect(await (await h.post(visit, "setup/curator-actions", { enable: true })).json()).toMatchObject({ model: "opus" });
    const commits = repo.log().length;
    expect(commits).toBe(first + 1);

    const off = await h.post(visit, "setup/curator-actions", { enable: false });
    expect(await off.json()).toEqual({ enabled: false, path: SLEEP_WORKFLOW_PATH });
    expect(repo.files()[SLEEP_WORKFLOW_PATH]).toBeUndefined();
    expect(repo.log()[0]!.message).toMatch(/^chore: stop running sleep on GitHub Actions \[skip ci\]/);
    expect((await status()).curatorActions).toBe(false);
    expect((await h.post(visit, "setup/curator-actions", { enable: false })).status).toBe(200);
    expect(repo.log()).toHaveLength(commits + 1);
  });

  it("explains a missing Workflows permission", async () => {
    const h = await hostedApp();
    const { visit, installation } = await h.readyAccount(PLAYER);
    installation.permissions = { metadata: "read", contents: "write" };
    const res = await h.post(visit, "setup/curator-actions", { enable: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "APP_PERMISSIONS" });
    expect(h.gh.at("player/vault").files()[SLEEP_WORKFLOW_PATH]).toBeUndefined();
  });

  it("needs a ready vault", async () => {
    const h = await hostedApp();
    const { visit, vault } = await h.readyAccount(PLAYER);
    await h.registry.setVaultStatus(vault, "disconnected", "suspended");
    expect(await (await h.post(visit, "setup/curator-actions", { enable: true })).json()).toMatchObject({ code: "NOT_READY" });
  });

  it("runs Claude through the MCP server only: no checkout, no repo permissions", () => {
    const w = SLEEP_WORKFLOW;
    expect(w).toContain('cron: "23 3 * * *"');
    // Up to 100 episodes a run: long enough for that, and a cut-off run only leaves the rest in the inbox.
    expect(w).toContain("timeout-minutes: 120");
    expect(w).toContain("workflow_dispatch:");
    expect(w).toMatch(/^permissions: \{\}$/m);
    expect(w).not.toContain("actions/checkout");
    expect(w.match(/^\s+- uses: /gm)).toEqual(["      - uses: "]);
    expect(w).toContain("uses: anthropics/claude-code-action@v1");
    // With both secrets set, the subscription token wins: Claude Code would use an API key it's given.
    expect(w).toContain("anthropic_api_key: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN == '' && secrets.ANTHROPIC_API_KEY || '' }}");
    expect(w).toContain("claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
    expect(w).not.toMatch(/anthropic_api_key: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);
    expect(w).toContain("Setup → Nightly curation");
    // The address and model are baked in; the repo's variables, if someone set them by hand, still win.
    expect(w).toContain(`--mcp-config '{"mcpServers":{"hippocampus":{"type":"http","url":"\${{ vars.HIPPO_MCP_URL || '${EXAMPLE_MCP_URL}' }}","headers":{"Authorization":"Bearer \${{ secrets.HIPPO_CURATOR_KEY }}"}}}}'`);
    expect(w).toContain('--allowedTools "mcp__hippocampus__*"');
    expect(w).toContain("--model ${{ vars.HIPPO_CURATOR_MODEL || 'sonnet' }}");
    expect(sleepWorkflow({ mcpUrl: EXAMPLE_MCP_URL, model: "opus" })).toContain("--model ${{ vars.HIPPO_CURATOR_MODEL || 'opus' }}");
    expect([bakedModel(w), bakedMcpUrl(w)]).toEqual(["sonnet", EXAMPLE_MCP_URL]);
    // Nothing that could break out of the quoted YAML and JSON gets baked in.
    for (const mcpUrl of ["https://x.example/mcp/a' }}", 'https://x.example/"', "https://x.example/${{ secrets.X }}", "javascript:alert(1)"]) expect(() => sleepWorkflow({ mcpUrl, model: "sonnet" })).toThrow();
    expect(() => sleepWorkflow({ mcpUrl: EXAMPLE_MCP_URL, model: "opus' }}" })).toThrow();
    expect(w).toContain("sleep_start");
    // The JSON in --mcp-config must parse once GitHub fills in its expressions (their quotes go with them).
    const config = /--mcp-config '([^']+)'/.exec(w.replace(/\$\{\{[^}]+\}\}/g, "x"))![1]!;
    expect(JSON.parse(config)).toEqual({ mcpServers: { hippocampus: { type: "http", url: "x", headers: { Authorization: "Bearer x" } } } });
  });

  it("says why a run failed with the final result's text only", () => {
    const step = SLEEP_WORKFLOW.slice(SLEEP_WORKFLOW.indexOf("- name: Say why it failed"));
    expect(SLEEP_WORKFLOW).toMatch(/- uses: anthropics\/claude-code-action@v1\n\s+id: claude\n/);
    expect(step).toContain("if: failure() && steps.claude.outputs.execution_file != ''");
    expect(step).toContain("EXECUTION_FILE: ${{ steps.claude.outputs.execution_file }}");
    // The file's other messages hold tool results (vault content): only the last result's text is printed.
    expect(step).toContain(`jq -r 'last | select(.type == "result") | .result // empty' "$EXECUTION_FILE"`);
    expect(step.match(/\$EXECUTION_FILE/g)).toHaveLength(2);
    expect(step).not.toMatch(/\bcat\b/);
  });
});

/** The App with the Actions permissions an operator adds (and each installation approves). */
const ACTIONS_GRANTED = { metadata: "read", contents: "write", workflows: "write", secrets: "write", actions: "write" } as const;
const SUBSCRIPTION = "sk-ant-oat01-residency-agent-example-token";
const API_KEY = "sk-ant-api03-harbor-university-example-key";

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function actionsAccount(opts: { granted?: boolean } = {}) {
  const h = await hostedApp();
  const { visit, vault, installation } = await h.readyAccount(PLAYER);
  if (opts.granted !== false) installation.permissions = { ...ACTIONS_GRANTED };
  const repo = h.gh.at("player/vault");
  const pair = nacl.box.keyPair();
  repo.actions.publicKey = { key_id: "3380204578043523366", key: b64(pair.publicKey) };
  /** A secret as the repo holds it, opened with the repo's private key. */
  const opened = (name: string) => {
    const s = repo.actions.secrets.get(name);
    if (!s) return undefined;
    const sealed = fromB64(s.encrypted_value);
    const epk = sealed.subarray(0, 32);
    const box = nacl.box.open(sealed.subarray(32), sealNonce(epk, pair.publicKey), epk, pair.secretKey);
    return box ? new TextDecoder().decode(box) : "(unopenable)";
  };
  const state = async () => (await (await h.api(visit, "setup/curator-actions/state")).json()) as HostedCuratorActionsState;
  const save = async (body: unknown) => h.post(visit, "setup/curator-actions/secrets", body);
  const actionsKeys = async () => (await h.registry.keys(vault)).filter((k) => k.kind === "curator" && k.app === "github-actions");
  return { h, visit, vault, installation, repo, opened, state, save, actionsKeys };
}

describe("the Actions curator's secrets, model and runs", () => {
  it("seals the credential and a new curator key for the repo, and bakes the model into the workflow", async () => {
    const { h, visit, repo, opened, state, save, actionsKeys } = await actionsAccount();
    await h.post(visit, "setup/curator-actions", { enable: true });
    const status = (await (await h.api(visit, "setup/status")).json()) as HostedSetupStatus;
    const workflow = () => repo.files()[SLEEP_WORKFLOW_PATH];

    const res = await save({ claudeToken: ` ${SUBSCRIPTION}\n`, model: "opus" });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ saved: ["CLAUDE_CODE_OAUTH_TOKEN", "HIPPO_CURATOR_KEY"], removed: [], curatorKey: "replaced", model: "opus" });
    // Write-only: the answer and the logs never hold a value.
    expect(text).not.toContain(SUBSCRIPTION);
    expect(text).not.toContain("hippo_");
    expect(opened("CLAUDE_CODE_OAUTH_TOKEN")).toBe(SUBSCRIPTION);
    const curatorKey = opened("HIPPO_CURATOR_KEY")!;
    expect(await h.registry.keyForToken(curatorKey)).toMatchObject({ kind: "curator", app: "github-actions", label: "GitHub Actions" });
    expect(repo.actions.secrets.has("ANTHROPIC_API_KEY")).toBe(false);
    // No repository variables: the model went into the workflow file.
    expect(repo.calls.some((c) => c.includes("actions/variables"))).toBe(false);
    expect(workflow()).toBe(sleepWorkflow({ mcpUrl: status.mcpUrl, model: "opus" }));
    // The token that wrote the secrets could do that and no more: no contents, no workflows.
    expect([...h.gh.tokens.values()]).toContainEqual(expect.objectContaining({ permissions: { metadata: "read", secrets: "write" }, repos: ["player/vault"] }));

    expect(await state()).toEqual({
      enabled: true,
      mcpUrl: status.mcpUrl,
      workflow: { mcpUrl: status.mcpUrl, model: "opus" },
      secrets: ["CLAUDE_CODE_OAUTH_TOKEN", "HIPPO_CURATOR_KEY"],
      runs: [],
    });

    // The other kind replaces the first, and the curator key is replaced with it: the old one stops working.
    const commits = repo.log().length;
    const again = await save({ apiKey: API_KEY });
    expect(await again.json()).toEqual({ saved: ["ANTHROPIC_API_KEY", "HIPPO_CURATOR_KEY"], removed: ["CLAUDE_CODE_OAUTH_TOKEN"], curatorKey: "replaced" });
    // No model given: the workflow is left alone.
    expect(repo.log()).toHaveLength(commits);
    expect(opened("ANTHROPIC_API_KEY")).toBe(API_KEY);
    expect(repo.actions.secrets.has("CLAUDE_CODE_OAUTH_TOKEN")).toBe(false);
    expect(await h.registry.keyForToken(curatorKey)).toBeUndefined();
    expect(await actionsKeys()).toHaveLength(1);
    expect(opened("HIPPO_CURATOR_KEY")).not.toBe(curatorKey);

    // Only the model: the key stays, and the workflow is rewritten in one commit; the same model again changes nothing.
    const kept = opened("HIPPO_CURATOR_KEY");
    expect(await (await save({ model: "sonnet" })).json()).toEqual({ saved: [], removed: [], curatorKey: "kept", model: "sonnet" });
    expect(opened("HIPPO_CURATOR_KEY")).toBe(kept);
    expect(workflow()).toBe(sleepWorkflow({ mcpUrl: status.mcpUrl, model: "sonnet" }));
    expect(repo.log()).toHaveLength(commits + 1);
    await save({ model: "sonnet" });
    expect(repo.log()).toHaveLength(commits + 1);
    expect(await state()).toMatchObject({ secrets: ["ANTHROPIC_API_KEY", "HIPPO_CURATOR_KEY"], workflow: { model: "sonnet" } });
    expect(await state()).not.toHaveProperty("outdated");

    // A key revoked under Connected apps is made again on the next save.
    for (const k of await actionsKeys()) await h.registry.revokeKey(k.vaultId, k.id);
    expect(await (await save({})).json()).toMatchObject({ curatorKey: "replaced", saved: ["HIPPO_CURATOR_KEY"] });

    const logs = h.logs.join("\n");
    for (const v of [SUBSCRIPTION, API_KEY, curatorKey]) expect(logs).not.toContain(v);
  });

  it("checks what's pasted before anything reaches GitHub", async () => {
    const { save, repo, actionsKeys } = await actionsAccount();
    const code = async (body: unknown) => ((await (await save(body)).json()) as { code: string }).code;
    expect(await code({ claudeToken: SUBSCRIPTION, apiKey: API_KEY })).toBe("INVALID");
    expect(await code({ claudeToken: "" })).toBe("INVALID");
    expect(await code({ claudeToken: "two words" })).toBe("INVALID");
    expect(await code({ apiKey: "x".repeat(600) })).toBe("INVALID");
    expect(await code({ apiKey: "hippo_abc" })).toBe("INVALID");
    expect(await code({ apiKey: SUBSCRIPTION })).toBe("WRONG_KIND");
    expect(await code({ claudeToken: API_KEY })).toBe("WRONG_KIND");
    expect(await code({ model: "haiku" })).toBe("INVALID");
    expect(repo.actions.secrets.size).toBe(0);
    expect(await actionsKeys()).toEqual([]);
  });

  it("runs the workflow now and lists its runs, a failed one included", async () => {
    const { h, visit, repo, state } = await actionsAccount();
    expect(await (await h.post(visit, "setup/curator-actions/run", {})).json()).toMatchObject({ code: "NOT_ENABLED" });
    await h.post(visit, "setup/curator-actions", { enable: true });
    repo.actions.runs.set("sleep.yml", [{ id: 41, status: "completed", conclusion: "failure", created_at: "2026-11-15T03:23:00Z", html_url: "https://github.test/player/vault/actions/runs/41", event: "schedule" }]);
    const res = await h.post(visit, "setup/curator-actions/run", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: true });
    expect(repo.actions.dispatches).toEqual([{ workflow: "sleep.yml", ref: "main" }]);
    expect([...h.gh.tokens.values()]).toContainEqual(expect.objectContaining({ permissions: { metadata: "read", actions: "write" } }));
    const runs = (await state()).runs!;
    expect(runs.map((r) => [r.status, r.conclusion, r.event])).toEqual([
      ["queued", null, "workflow_dispatch"],
      ["completed", "failure", "schedule"],
    ]);
    expect(runs[1]).toEqual({ id: 41, status: "completed", conclusion: "failure", created: "2026-11-15T03:23:00Z", url: "https://github.test/player/vault/actions/runs/41", event: "schedule" });
  });

  it("asks for the permissions the installation hasn't approved, with where to approve them", async () => {
    const { h, visit, installation, state, actionsKeys, repo } = await actionsAccount({ granted: false });
    const settingsUrl = `https://github.test/settings/installations/${installation.id}`;
    for (const [path, body] of [
      ["setup/curator-actions/secrets", { claudeToken: SUBSCRIPTION }],
      ["setup/curator-actions/run", {}],
    ] as const) {
      const res = await h.post(visit, path, body);
      expect(res.status, path).toBe(403);
      expect(await res.json(), path).toMatchObject({ code: "NEEDS_PERMISSION", settingsUrl, repo: "player/vault" });
    }
    // Nothing minted for a save that couldn't happen.
    expect(await actionsKeys()).toEqual([]);
    expect(repo.actions.secrets.size).toBe(0);
    // The state says so instead of failing, and setup's status loads as ever.
    expect(await state()).toMatchObject({ enabled: false, needsPermission: { repo: "player/vault", settingsUrl, who: "owner" } });
    expect((await h.api(visit, "setup/status")).status).toBe(200);
    // What's missing is named, from the installation's own permissions.
    expect(await (await h.post(visit, "setup/curator-actions/secrets", { claudeToken: SUBSCRIPTION })).json()).toMatchObject({ missing: ["secrets"] });
  });

  it("says when the workflow is an older copy, or calls another address, and turning it on brings it up to date", async () => {
    const { h, visit, repo, state } = await actionsAccount();
    const { mcpUrl } = (await (await h.api(visit, "setup/status")).json()) as HostedSetupStatus;
    // An older text (no baked model), as installs before this change have it.
    await repo.push({ [SLEEP_WORKFLOW_PATH]: SLEEP_WORKFLOW.replace(/HIPPO_CURATOR_MODEL \|\| '[a-z]+'/g, "HIPPO_CURATOR_MODEL || 'sonnet' ").replace(/ \|\| 'https:[^']+'/, "") });
    expect(await state()).toMatchObject({ enabled: true, outdated: true, workflow: { model: "sonnet" } });
    expect((await state()).workflow).not.toHaveProperty("mcpUrl");
    await h.post(visit, "setup/curator-actions", { enable: true });
    expect(repo.files()[SLEEP_WORKFLOW_PATH]).toBe(sleepWorkflow({ mcpUrl, model: "sonnet" }));
    expect(await state()).not.toHaveProperty("outdated");
    // Another vault's address (copied from elsewhere): outdated too, and the model it had is kept.
    await repo.push({ [SLEEP_WORKFLOW_PATH]: sleepWorkflow({ mcpUrl: EXAMPLE_MCP_URL, model: "opus" }) });
    expect(await state()).toMatchObject({ outdated: true, workflow: { mcpUrl: EXAMPLE_MCP_URL, model: "opus" } });
    expect(await (await h.post(visit, "setup/curator-actions", { enable: true })).json()).toMatchObject({ model: "opus" });
    expect(repo.files()[SLEEP_WORKFLOW_PATH]).toBe(sleepWorkflow({ mcpUrl, model: "opus" }));
  });

  it("sends an organization's owner to the organization's installation settings", async () => {
    const { h, visit, installation } = await actionsAccount({ granted: false });
    installation.account = { ...installation.account, login: "harbor-university", type: "Organization" };
    const res = await h.post(visit, "setup/curator-actions/run", {});
    expect(await res.json()).toMatchObject({ code: "NEEDS_PERMISSION", settingsUrl: `https://github.test/organizations/harbor-university/settings/installations/${installation.id}` });
  });

  it("tells an App that doesn't ask for the permissions (the operator's move) from one GitHub refuses for another reason", async () => {
    const { h, visit, state, installation } = await actionsAccount({ granted: false });
    h.gh.appPermissions = { metadata: "read", contents: "write", workflows: "write" };
    expect(await state()).toMatchObject({ needsPermission: { who: "operator" } });
    const res = await h.post(visit, "setup/curator-actions/run", {});
    expect(await res.json()).toMatchObject({ code: "NEEDS_PERMISSION", who: "operator", missing: ["actions"] });

    // Everything granted, and GitHub still refuses: said as itself, not as a permission to approve.
    h.gh.appPermissions = { ...ACTIONS_GRANTED };
    installation.permissions = { ...ACTIONS_GRANTED };
    h.gh.refuseTokens = true;
    const refused = await h.post(visit, "setup/curator-actions/run", {});
    expect(refused.status).toBe(502);
    expect(await refused.json()).toMatchObject({ code: "TOKEN_REFUSED" });
  });

  it("leaves out what GitHub couldn't answer, and takes back a key it couldn't store", async () => {
    const { h, visit, repo, state, save, actionsKeys } = await actionsAccount();
    await h.post(visit, "setup/curator-actions", { enable: true });
    repo.actions.failWith = 500;
    const s = await state();
    expect(s).toMatchObject({ enabled: true });
    expect(s).not.toHaveProperty("secrets");
    expect(s).not.toHaveProperty("runs");
    expect((await save({ claudeToken: SUBSCRIPTION })).status).toBe(502);
    expect(await actionsKeys()).toEqual([]);
    expect((await h.api(visit, "setup/status")).status).toBe(200);
  });

  it("is for the vault's owner only", async () => {
    const { h, visit } = await actionsAccount();
    const made = (await (await h.post(visit, "vaults/members/invite", { role: "member", human: "game-master", login: "game-master" })).json()) as HostedNewInvite;
    const gm = h.browser();
    await h.signIn(gm, "game-master");
    await h.post(gm, "invites/accept", { id: made.invite.id });
    for (const [path, body] of [
      ["setup/curator-actions/secrets", { claudeToken: SUBSCRIPTION }],
      ["setup/curator-actions/run", {}],
      ["setup/curator-actions/state", undefined],
    ] as const) {
      const res = body === undefined ? await h.api(gm, path) : await h.post(gm, path, body);
      expect(res.status, path).toBe(403);
      expect(await res.json(), path).toMatchObject({ code: "OWNER_ONLY" });
    }
  });
});
