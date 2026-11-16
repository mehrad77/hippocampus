import type { HostedNewInvite, HostedSetupStatus } from "@hippocampus/dashboard";
import { describe, expect, it } from "vitest";
import { PLAYER, TEST_TOKEN_KEY, hostedApp } from "../testing/hosted-app.ts";

// The setup routes for hosted curation: the account's model key (write-only), its caps, each vault's
// hour and Run now, and the Cron's backstop. The vault's object is FakeVaults' recorder here; what it
// does with a night is covered in vault-runtime.test.ts.

const GOOD_KEY = "sk-ant-test-harbor-university-9d3f";
const OTHER_KEY = "sk-ant-test-refused-0000";
const HAIKU = "claude-haiku-5-5";

/** Anthropic's model list: the good key sees Haiku and Sonnet; anything else is refused. */
const anthropic = (calls: string[] = []) => async (request: Request) => {
  calls.push(`${request.method} ${new URL(request.url).pathname}`);
  if (request.headers.get("x-api-key") !== GOOD_KEY) return Response.json({ error: { type: "authentication_error" } }, { status: 401 });
  return Response.json({ data: [{ id: HAIKU }, { id: "claude-sonnet-5-5" }] });
};

const save = (o: Record<string, unknown> = {}) => ({ provider: "anthropic", model: HAIKU, key: GOOD_KEY, monthCapUsd: 20, runCapUsd: 2, ...o });

async function owner(opts: { off?: boolean } = {}) {
  const calls: string[] = [];
  const h = await hostedApp({ settings: { tokenKey: TEST_TOKEN_KEY, ...(opts.off ? { hostedCuratorOff: true } : {}) }, llm: anthropic(calls) });
  const player = await h.readyAccount(PLAYER);
  const status = async () => ((await (await h.api(player.visit, "setup/status")).json()) as HostedSetupStatus).hostedCurator;
  return { h, ...player, calls, status };
}

describe("hosted curation: the account's model key", () => {
  it("checks the key with the provider, keeps it write-only, and never puts it in a response or a log", async () => {
    const { h, visit, calls, status } = await owner();
    expect(await status()).toMatchObject({ available: true, spentThisMonthUsd: 0, recommended: {}, vault: { enabled: false } });
    expect((await status())!.models).toContainEqual({ provider: "anthropic", model: HAIKU, inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5 });
    const seen: string[] = [];
    const post = async (path: string, body: unknown) => {
      const res = await h.post(visit, path, body);
      const text = await res.text();
      seen.push(text);
      return { status: res.status, body: JSON.parse(text) as Record<string, any> };
    };

    const refused = await post("setup/curator-llm", save({ key: OTHER_KEY }));
    expect(refused).toMatchObject({ status: 400, body: { code: "KEY_AUTH" } });
    const missing = await post("setup/curator-llm", save({ steps: { mentions: HAIKU, match: HAIKU, claims: "claude-opus-5-5", summary: HAIKU } }));
    expect(missing).toMatchObject({ status: 400, body: { code: "KEY_MODELS_MISSING", missing: ["claude-opus-5-5"] } });
    expect((await post("setup/curator-llm", save({ model: "claude-unpriced-1" }))).status).toBe(400);
    expect((await post("setup/curator-llm", save({ monthCapUsd: -1 }))).body).toMatchObject({ code: "INVALID" });

    const saved = await post("setup/curator-llm", save());
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      available: true,
      provider: "anthropic",
      steps: { mentions: HAIKU, match: HAIKU, claims: HAIKU, summary: HAIKU },
      keyHint: "…9d3f",
      monthCapUsd: 20,
      runCapUsd: 2,
      spentThisMonthUsd: 0,
    });
    expect(calls.filter((c) => c === "GET /v1/models")).toHaveLength(3);

    // New caps without the key: checked again with the saved one.
    expect((await post("setup/curator-llm", { provider: "anthropic", model: HAIKU, monthCapUsd: 30, runCapUsd: 3 })).body).toMatchObject({ monthCapUsd: 30, keyHint: "…9d3f" });
    expect(calls.filter((c) => c === "GET /v1/models")).toHaveLength(4);
    // A new provider needs its own key.
    expect((await post("setup/curator-llm", { provider: "mistral", model: "mistral-small-2603", monthCapUsd: 30, runCapUsd: 3 })).body).toMatchObject({ code: "INVALID" });

    seen.push(JSON.stringify(await status()));
    for (const text of [...seen, ...h.logs]) {
      expect(text).not.toContain(GOOD_KEY);
      expect(text).not.toContain(OTHER_KEY);
    }
    expect(h.logs.map((l) => JSON.parse(l) as { route: string }).filter((l) => l.route === "POST setup/curator-llm")).not.toHaveLength(0);
  });

  it("sets the vault's hour, starts a run now, and tells the vault's object", async () => {
    const { h, visit, vault, status } = await owner();
    // No key yet: nothing to run with.
    expect(await (await h.post(visit, "setup/curator-llm/vault", { hourUtc: 3 })).json()).toMatchObject({ code: "NO_KEY" });
    await h.post(visit, "setup/curator-llm", save());

    expect((await h.post(visit, "setup/curator-llm/vault", { hourUtc: 24 })).status).toBe(400);
    expect(await (await h.post(visit, "setup/curator-llm/vault", { hourUtc: 3 })).json()).toEqual({ enabled: true, hourUtc: 3 });
    expect(h.vaults.to(vault, "setHostedSchedule")).toEqual([expect.objectContaining({ hourUtc: 3 })]);
    expect(await h.app.routes.llm!.scheduledVaults()).toEqual([vault]);
    expect((await status())!.vault).toEqual({ enabled: true, hourUtc: 3 });

    expect(await (await h.post(visit, "setup/curator-llm/run", {})).json()).toEqual({ run: "run-01hosted" });
    h.vaults.runNow.set(vault, { code: "IDLE", message: "Nothing is waiting in the inbox." });
    const idle = await h.post(visit, "setup/curator-llm/run", {});
    expect(idle.status).toBe(409);
    expect(await idle.json()).toMatchObject({ code: "IDLE", error: "Nothing is waiting in the inbox." });

    expect(await (await h.post(visit, "setup/curator-llm/vault", { hourUtc: null })).json()).toEqual({ enabled: false });
    expect(await h.app.routes.llm!.scheduledVaults()).toEqual([]);
  });

  it("is for the vault's owner only", async () => {
    const { h, visit } = await owner();
    const made = (await (await h.post(visit, "vaults/members/invite", { role: "member", human: "game-master", login: "game-master" })).json()) as HostedNewInvite;
    const gm = h.browser();
    await h.signIn(gm, "game-master");
    await h.post(gm, "invites/accept", { id: made.invite.id });
    for (const [path, body] of [
      ["setup/curator-llm", save()],
      ["setup/curator-llm/vault", { hourUtc: 3 }],
      ["setup/curator-llm/run", {}],
    ] as const) {
      const res = await h.post(gm, path, body);
      expect(res.status, path).toBe(403);
      expect(await res.json(), path).toMatchObject({ code: "OWNER_ONLY" });
    }
  });

  it("isn't offered without HIPPO_TOKEN_KEY, and is refused while the operator has it switched off", async () => {
    const plain = await hostedApp({ llm: anthropic() });
    const p = await plain.readyAccount(PLAYER);
    expect(((await (await plain.api(p.visit, "setup/status")).json()) as HostedSetupStatus).hostedCurator).toBeUndefined();
    expect(await (await plain.post(p.visit, "setup/curator-llm", save())).json()).toMatchObject({ code: "UNAVAILABLE" });

    const off = await owner({ off: true });
    expect(await off.status()).toMatchObject({ available: false });
    expect(await (await off.h.post(off.visit, "setup/curator-llm", save())).json()).toMatchObject({ code: "UNAVAILABLE" });
  });
});

describe("hosted curation: the Cron's backstop", () => {
  it("asks each scheduled vault's object to re-arm a lost alarm", async () => {
    const { h, visit, vault } = await owner();
    expect(await h.app.ensureHostedAlarms()).toBe(0);
    await h.post(visit, "setup/curator-llm", save());
    await h.post(visit, "setup/curator-llm/vault", { hourUtc: 4 });
    expect(await h.app.ensureHostedAlarms()).toBe(1);
    expect(h.vaults.to(vault, "ensureAlarm")).toHaveLength(1);
    expect(h.logs.some((l) => l.includes('"route":"cron hosted-curator"') && !l.includes(vault))).toBe(true);
  });
});
