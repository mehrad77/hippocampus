import type { HostedSetupStatus } from "@hippocampus/dashboard";
import { describe, expect, it } from "vitest";
import { PLAYER, hostedApp } from "../testing/hosted-app.ts";
import { SLEEP_WORKFLOW, SLEEP_WORKFLOW_PATH } from "./curator-actions.ts";

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
    const on = await h.post(visit, "setup/curator-actions", { enable: true });
    expect(await on.json()).toEqual({ enabled: true, path: SLEEP_WORKFLOW_PATH });
    expect(repo.files()[SLEEP_WORKFLOW_PATH]).toBe(SLEEP_WORKFLOW);
    expect(repo.log()[0]!.message).toBe("chore: run sleep nightly on GitHub Actions [skip ci]\n\nHippo-Actor: bootstrap");
    // GitHub refuses workflow files from a token without `workflows: write`; the one used had it, for this repo only.
    expect([...h.gh.tokens.values()].some((t) => t.permissions?.workflows === "write" && t.repos?.join() === "player/vault")).toBe(true);
    expect(await status()).toMatchObject({ curatorActions: true, items: expect.arrayContaining([expect.objectContaining({ id: "curator", state: "done" })]) });

    // Already there: nothing to commit.
    const commits = repo.log().length;
    await h.post(visit, "setup/curator-actions", { enable: true });
    expect(repo.log()).toHaveLength(commits);

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
    expect(w).toContain("workflow_dispatch:");
    expect(w).toMatch(/^permissions: \{\}$/m);
    expect(w).not.toContain("actions/checkout");
    expect(w.match(/^\s+- uses: /gm)).toEqual(["      - uses: "]);
    expect(w).toContain("uses: anthropics/claude-code-action@v1");
    expect(w).toContain("anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}");
    expect(w).toContain(`--mcp-config '{"mcpServers":{"hippocampus":{"type":"http","url":"\${{ vars.HIPPO_MCP_URL }}","headers":{"Authorization":"Bearer \${{ secrets.HIPPO_CURATOR_KEY }}"}}}}'`);
    expect(w).toContain('--allowedTools "mcp__hippocampus__*"');
    expect(w).toContain("--model ${{ vars.HIPPO_CURATOR_MODEL || 'sonnet' }}");
    expect(w).toContain("sleep_start");
    // The JSON in --mcp-config must parse once GitHub fills in its expressions.
    const config = /--mcp-config '([^']+)'/.exec(w)![1]!.replace(/\$\{\{[^}]+\}\}/g, "x");
    expect(JSON.parse(config)).toEqual({ mcpServers: { hippocampus: { type: "http", url: "x", headers: { Authorization: "Bearer x" } } } });
  });
});
