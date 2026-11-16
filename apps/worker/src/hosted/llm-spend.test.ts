import { BudgetExhausted } from "@hippocampus/curator";
import { describe, expect, it } from "vitest";
import { HttpError } from "@hippocampus/dashboard";
import { LlmAccess, checkKey, pausedNow } from "./llm-access.ts";
import { AccountMeter, RESERVATION_MS, monthSpend, type RunLedger } from "./llm-spend.ts";
import { Registry } from "./registry.ts";
import { registryDb } from "./testing.ts";

const PLAYER = { id: 4242, login: "player" };
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const MIX = { mentions: "claude-haiku-5-5", match: "claude-haiku-5-5", claims: "claude-sonnet-5-5", summary: "claude-haiku-5-5" };

async function world(at = new Date("2026-11-16T03:00:00Z")) {
  let t = at.getTime();
  const clock = () => new Date(t);
  const db = await registryDb();
  const registry = new Registry(db, clock);
  await registry.signIn(PLAYER, { admin: true });
  return { db, registry, clock, advance: (ms: number) => (t += ms), access: new LlmAccess(db, KEY, clock) };
}

/** A run's ledger in memory, as the Durable Object keeps it. */
function ledger(): RunLedger & { unit(): void } {
  let micros = 0;
  let unitMicros = 0;
  let calls = 0;
  return {
    get: () => ({ micros, unitMicros, calls }),
    add: (m) => {
      micros += m;
      unitMicros += m;
      calls++;
    },
    unit: () => (unitMicros = 0),
  };
}

describe("the account's model budget", () => {
  it("never lets two vaults of one account pass the month's cap together", async () => {
    const { db, clock } = await world();
    const meters = [0, 1].map(() => new AccountMeter(db, { accountId: PLAYER.id, monthCapMicros: 10_000, runCapMicros: 1_000_000, run: ledger(), now: clock }));
    const held = await Promise.all(Array.from({ length: 8 }, (_, i) => meters[i % 2]!.reserve(3_000)));
    expect(held.filter(Boolean)).toHaveLength(3);
    for (const [i, r] of held.entries()) if (r) await meters[i % 2]!.settle(r, 3_000);
    expect(await monthSpend(db, PLAYER.id, clock())).toBe(9_000);
    expect(await meters[0]!.reserve(1_500)).toBeUndefined();
  });

  it("settles to what a call used, and starts the month afresh", async () => {
    const { db, clock, advance } = await world(new Date("2026-11-30T23:00:00Z"));
    const meter = new AccountMeter(db, { accountId: PLAYER.id, monthCapMicros: 5_000, runCapMicros: 1_000_000, run: ledger(), now: clock });
    const r = (await meter.reserve(4_000))!;
    await meter.settle(r, 1_200);
    expect(await monthSpend(db, PLAYER.id, clock())).toBe(1_200);
    advance(2 * 60 * 60_000);
    expect(await monthSpend(db, PLAYER.id, clock())).toBe(0);
    expect(await meter.reserve(5_000)).toBeDefined();
  });

  it("counts a reservation left by an evicted object as spent once it expires, and leaves a live one alone", async () => {
    const { db, clock, advance } = await world();
    const gone = new AccountMeter(db, { accountId: PLAYER.id, monthCapMicros: 10_000, runCapMicros: 1_000_000, run: ledger(), now: clock });
    await gone.reserve(4_000);
    advance(RESERVATION_MS - 1);
    const next = new AccountMeter(db, { accountId: PLAYER.id, monthCapMicros: 10_000, runCapMicros: 1_000_000, run: ledger(), now: clock });
    expect(await next.reserve(1_000)).toBeDefined();
    expect(await monthSpend(db, PLAYER.id, clock())).toBe(0);
    advance(2);
    const r = (await next.reserve(1_000))!;
    expect(await monthSpend(db, PLAYER.id, clock())).toBe(4_000);
    // Settling one that was swept doesn't count it twice.
    advance(RESERVATION_MS + 1);
    await next.reserve(1);
    await next.settle(r, 10);
    expect(await monthSpend(db, PLAYER.id, clock())).toBe(6_000);
  });

  it("stops at the per-run cap, and tells an episode too large for it from a run that's spent", async () => {
    const { db, clock } = await world();
    const run = ledger();
    const meter = new AccountMeter(db, { accountId: PLAYER.id, monthCapMicros: 1_000_000, runCapMicros: 5_000, run, now: clock });
    run.unit();
    const a = (await meter.reserve(3_000))!;
    await meter.settle(a, 3_000);
    const tooBig = await meter.reserve(3_000).catch((e: unknown) => e);
    expect(tooBig).toBeInstanceOf(BudgetExhausted);
    expect((tooBig as BudgetExhausted).tooLarge).toBe(true);
    run.unit();
    const spent = await meter.reserve(3_000).catch((e: unknown) => e);
    expect((spent as BudgetExhausted).tooLarge).toBe(false);
  });
});

describe("the account's model key", () => {
  it("keeps the key sealed for its own account, and shows only its last four characters", async () => {
    const { db, registry, access } = await world();
    const s = await access.save(PLAYER.id, { provider: "anthropic", steps: MIX, key: "sk-ant-api03-secret-wxyz", monthCapMicros: 5_000_000, runCapMicros: 500_000 });
    expect(s).toMatchObject({ provider: "anthropic", keyHint: "…wxyz", monthCapMicros: 5_000_000 });
    expect(JSON.stringify(s)).not.toContain("secret");
    expect(await access.keyFor(PLAYER.id)).toBe("sk-ant-api03-secret-wxyz");
    const [row] = await db.all<{ secret: string }>("SELECT secret FROM llm_credentials");
    expect(row!.secret).not.toContain("sk-ant");
    // Bound to the account: the same box doesn't open as anyone else's.
    await registry.signIn({ id: 7, login: "game-master" });
    await db.all("INSERT INTO llm_credentials SELECT 7, provider, steps, secret, key_hint, month_cap_micros, run_cap_micros, paused, updated FROM llm_credentials WHERE account_id = ?", [PLAYER.id]);
    expect(await db.all("SELECT account_id FROM llm_credentials ORDER BY account_id")).toEqual([{ account_id: 7 }, { account_id: PLAYER.id }]);
    expect(await access.keyFor(7)).toBeUndefined();
  });

  it("refuses a model it can't price, and a first save without a key", async () => {
    const { access } = await world();
    await expect(access.save(PLAYER.id, { provider: "anthropic", steps: { ...MIX, claims: "claude-made-up" }, key: "k", monthCapMicros: 1, runCapMicros: 1 })).rejects.toThrow("no price for claims");
    await expect(access.save(PLAYER.id, { provider: "anthropic", steps: MIX, monthCapMicros: 1, runCapMicros: 1 })).rejects.toBeInstanceOf(HttpError);
  });

  it("lifts a key pause when a key is saved, and a budget pause when the cap is raised or the month ends", async () => {
    const { access, clock } = await world();
    await access.save(PLAYER.id, { provider: "anthropic", steps: MIX, key: "k-1234", monthCapMicros: 0, runCapMicros: 1 });
    await access.pause(PLAYER.id, "auth");
    expect((await access.settings(PLAYER.id))!.paused).toBe("auth");
    await access.save(PLAYER.id, { provider: "anthropic", steps: MIX, monthCapMicros: 0, runCapMicros: 1 });
    expect((await access.settings(PLAYER.id))!.paused).toBe("auth");
    await access.save(PLAYER.id, { provider: "anthropic", steps: MIX, key: "k-5678", monthCapMicros: 0, runCapMicros: 1 });
    expect((await access.settings(PLAYER.id))!.paused).toBeUndefined();
    await access.pause(PLAYER.id, "budget");
    expect((await access.settings(PLAYER.id))!.paused).toBe("budget:2026-11");
    expect(pausedNow("budget:2026-11", new Date("2026-12-01T00:00:00Z"))).toBeUndefined();
    await access.save(PLAYER.id, { provider: "anthropic", steps: MIX, monthCapMicros: 100, runCapMicros: 1 });
    expect((await access.settings(PLAYER.id))!.paused).toBeUndefined();
    expect(clock()).toBeDefined();
  });

  it("goes with the account when it is deleted", async () => {
    const { db, registry, access } = await world();
    await access.save(PLAYER.id, { provider: "mistral", steps: { mentions: "mistral-small-2603", match: "mistral-small-2603", claims: "mistral-large-4", summary: "mistral-small-2603" }, key: "m-key", monthCapMicros: 1, runCapMicros: 1 });
    await registry.removeAccount(PLAYER.id);
    expect(await db.all("SELECT * FROM llm_credentials")).toEqual([]);
  });

  it("checks a key against the provider's model list, free, without echoing it", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fake = (status: number, ids: string[]) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(url), headers: init?.headers as Record<string, string> });
        return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status });
      }) as typeof fetch;
    expect(await checkKey("anthropic", "sk-1", MIX, { fetch: fake(200, ["claude-haiku-5-5", "claude-sonnet-5-5"]) })).toEqual({ ok: true });
    expect(seen[0]).toMatchObject({ url: "https://api.anthropic.com/v1/models?limit=1000", headers: { "x-api-key": "sk-1" } });
    expect(await checkKey("anthropic", "sk-1", MIX, { fetch: fake(200, ["claude-haiku-5-5"]) })).toEqual({ ok: false, code: "models_missing", missing: ["claude-sonnet-5-5"] });
    const refused = await checkKey("mistral", "sk-secret", MIX, { fetch: fake(401, []) });
    expect(refused).toEqual({ ok: false, code: "auth" });
    expect(JSON.stringify(refused)).not.toContain("sk-secret");
  });
});
