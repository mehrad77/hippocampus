import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ScriptedLLM, aiSdkLLM, stepLLM, usageOf } from "./llm.ts";
import { BudgetExhausted, CappedMeter, ProviderStop, RunStop, metered, promptTokenBound, stopFor, type Meter, type Reservation } from "./meter.ts";
import { PRICES, costMicros, mixLabel, priceOf, worstCaseMicros, type Price } from "./pricing.ts";

const price: Price = { provider: "anthropic", model: "test-model", input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, checked: "2026-11-16", source: "test" };

/** A meter that records each reservation and what it settled to. */
class Ledger implements Meter {
  readonly log: { held: number; settled?: number }[] = [];
  constructor(private readonly refuseAfter = Infinity) {}
  async reserve(micros: number): Promise<Reservation | undefined> {
    if (this.log.length >= this.refuseAfter) return undefined;
    this.log.push({ held: micros });
    return { id: String(this.log.length - 1), micros };
  }
  async settle(r: Reservation, actual: number): Promise<void> {
    this.log[Number(r.id)]!.settled = actual;
  }
}

/** An OpenAI-compatible server answering `replies` in turn, reporting 1,000 prompt and 100 completion tokens. */
async function fakeModel(replies: (string | number)[]) {
  let i = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const reply = replies[Math.min(i++, replies.length - 1)]!;
      if (typeof reply === "number") return res.writeHead(reply, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Your credit balance is too low" } }));
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: "c",
          object: "chat.completion",
          created: 0,
          model: "m",
          choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { baseURL: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((r) => server.close(() => r())), calls: () => i };
}

describe("pricing", () => {
  it("prices usage in micro-dollars, rounding up, with cache reads, writes and the long-prompt tier", () => {
    expect(costMicros({ input: 1_000, output: 100 }, price)).toBe(1_500);
    expect(costMicros({ input: 1, output: 0 }, { ...price, input: 0.15 })).toBe(1);
    expect(costMicros({ input: 0, output: 0, cacheRead: 1_000, cacheWrite: 1_000 }, price)).toBe(1_350);
    const haiku = priceOf("anthropic", "claude-haiku-5-5")!;
    expect(costMicros({ input: 200_000, output: 1_000 }, haiku)).toBe(200_000 * 0.5 + 1_000 * 2.5);
  });

  it("puts the worst case above any real usage of the same size", () => {
    for (const p of PRICES) {
      const worst = worstCaseMicros(5_000, 500, p);
      expect(worst, p.model).toBeGreaterThanOrEqual(costMicros({ input: 5_000, output: 500 }, p));
      expect(worst, p.model).toBeGreaterThanOrEqual(costMicros({ input: 0, output: 500, cacheWrite: 5_000 }, p));
    }
  });

  it("dates every row and names its source", () => {
    for (const p of PRICES) {
      expect(p.checked, p.model).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.source, p.model).toMatch(/^https:\/\//);
    }
    expect(priceOf("anthropic", "claude-made-up")).toBeUndefined();
  });

  it("labels a mix compactly, within the trailer's 120 characters", () => {
    expect(mixLabel("anthropic", { mentions: "a", match: "a", claims: "a", summary: "a" })).toBe("anthropic:a");
    expect(mixLabel("mistral", { mentions: "small", match: "small", claims: "large", summary: "small" })).toBe("mistral:small(mentions,match,summary)+large(claims)");
    expect(mixLabel("mistral", { mentions: "x".repeat(60), match: "y".repeat(60), claims: "z", summary: "z" })).toHaveLength(120);
  });
});

describe("the meter", () => {
  it("reserves the worst case before a call, and settles it to what was used", async () => {
    const ledger = new Ledger();
    const value = await metered(ledger, price, { promptTokens: 2_000, maxOutputTokens: 300 }, async () => ({ value: 7, usage: { input: 1_000, output: 100 } }));
    expect(value).toBe(7);
    expect(ledger.log).toEqual([{ held: worstCaseMicros(2_000, 300, price), settled: 1_500 }]);
  });

  it("keeps the whole reservation when a call fails or reports no usage, and turns provider failures into stops", async () => {
    const ledger = new Ledger();
    await expect(metered(ledger, price, { promptTokens: 10, maxOutputTokens: 10 }, async () => Promise.reject(Object.assign(new Error("x"), { statusCode: 401 })))).rejects.toBeInstanceOf(ProviderStop);
    await metered(ledger, price, { promptTokens: 10, maxOutputTokens: 10 }, async () => ({ value: 1 }));
    expect(ledger.log.map((l) => l.settled)).toEqual([ledger.log[0]!.held, ledger.log[1]!.held]);
    const plain = new Error("bad answer");
    await expect(metered(ledger, price, { promptTokens: 10, maxOutputTokens: 10 }, async () => Promise.reject(plain))).rejects.toBe(plain);
  });

  it("refuses a call it can't cover, before making it", async () => {
    let made = 0;
    const err = await metered(new CappedMeter(100), price, { promptTokens: 1_000, maxOutputTokens: 100 }, async () => ({ value: made++ })).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExhausted);
    expect(err).toBeInstanceOf(RunStop);
    expect((err as RunStop).stop).toBe("budget");
    expect(made).toBe(0);
  });

  it("never spends past the cap, whatever the calls use", async () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
    for (let round = 0; round < 50; round++) {
      const cap = 5_000 + Math.floor(rand() * 50_000);
      const meter = new CappedMeter(cap);
      for (;;) {
        const bound = { promptTokens: 100 + Math.floor(rand() * 3_000), maxOutputTokens: 50 + Math.floor(rand() * 500) };
        const used = { input: Math.floor(rand() * bound.promptTokens), output: Math.floor(rand() * bound.maxOutputTokens) };
        const r = await metered(meter, price, bound, async () => ({ value: 1, usage: used })).catch((e) => e);
        if (r instanceof BudgetExhausted) break;
      }
      expect(meter.spent).toBeLessThanOrEqual(cap);
      expect(meter.held).toBe(0);
    }
  });

  it("maps provider failures to a code, never carrying the provider's text", () => {
    expect(stopFor({ statusCode: 401, message: "invalid x-api-key sk-ant-secret" })).toMatchObject({ stop: "auth", status: 401 });
    expect(stopFor({ statusCode: 400, responseBody: '{"error":{"message":"Your credit balance is too low"}}' })?.stop).toBe("credit");
    expect(stopFor({ statusCode: 429 })?.stop).toBe("rate_limit");
    expect(stopFor({ statusCode: 529 })?.stop).toBe("provider");
    expect(stopFor({ name: "TimeoutError" })?.stop).toBe("provider");
    expect(stopFor({ statusCode: 400, message: "prompt is too long" })).toBeUndefined();
    expect(String(stopFor({ statusCode: 401, message: "sk-ant-secret" }))).not.toContain("sk-ant");
  });

  it("bounds a prompt's tokens by its UTF-8 bytes, plus the provider's framing", () => {
    expect(promptTokenBound(["abc", "é"], 0)).toBe(5);
    expect(promptTokenBound([""])).toBeGreaterThan(0);
  });
});

describe("a metered model", () => {
  it("reserves every prompt-mode attempt on its own, and settles each to the reported usage", async () => {
    const srv = await fakeModel(["no json", "still none", '{"ok": true}']);
    try {
      const ledger = new Ledger();
      const llm = aiSdkLLM({ provider: "lmstudio", model: "m", baseURL: srv.baseURL, maxOutputTokens: 200, meter: { meter: ledger, price } });
      expect(await llm.object({ name: "ping", schema: z.object({ ok: z.boolean() }), system: "s", prompt: "p" })).toEqual({ ok: true });
      expect(srv.calls()).toBe(3);
      expect(ledger.log).toHaveLength(3);
      for (const l of ledger.log) {
        expect(l.held).toBeGreaterThanOrEqual(l.settled!);
        expect(l.settled).toBe(costMicros({ input: 1_000, output: 100 }, price));
      }
    } finally {
      await srv.close();
    }
  });

  it("makes no SDK retries under a meter, and stops the run on spent credit", async () => {
    const srv = await fakeModel([400]);
    try {
      const ledger = new Ledger();
      const llm = aiSdkLLM({ provider: "lmstudio", model: "m", baseURL: srv.baseURL, maxRetries: 5, meter: { meter: ledger, price } });
      const err = await llm.object({ name: "ping", schema: z.object({ ok: z.boolean() }), system: "s", prompt: "p" }).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderStop);
      expect((err as ProviderStop).stop).toBe("credit");
      expect(srv.calls()).toBe(1);
      expect(ledger.log[0]!.settled).toBe(ledger.log[0]!.held);
    } finally {
      await srv.close();
    }
  });

  it("reads plain input apart from cache tokens", () => {
    const u = { inputTokens: 1_000, outputTokens: 50, inputTokenDetails: { noCacheTokens: 200, cacheReadTokens: 700, cacheWriteTokens: 100 } };
    expect(usageOf(u as never)).toEqual({ input: 200, output: 50, cacheRead: 700, cacheWrite: 100 });
    expect(usageOf({ inputTokens: undefined, outputTokens: 1 } as never)).toBeUndefined();
  });
});

describe("stepLLM", () => {
  it("sends each step to its own model, and anything else to the fallback", async () => {
    const small = new ScriptedLLM().respond("mentions", () => ({ by: "small" })).respond("match", () => ({ by: "small" }));
    const large = new ScriptedLLM().respond("claims", () => ({ by: "large" })).respond("summary", () => ({ by: "large" }));
    const other = new ScriptedLLM().respond("ping", () => ({ by: "other" }));
    const llm = stepLLM({ mentions: small, match: small, claims: large, summary: large }, other, "mistral:small(mentions,match)+large(claims,summary)");
    const ask = (name: string) => llm.object({ name, schema: z.object({ by: z.string() }), system: "", prompt: "" });
    expect(await Promise.all(["mentions", "match", "claims", "summary", "ping"].map(ask))).toEqual(["small", "small", "large", "large", "other"].map((by) => ({ by })));
    expect(stepLLM({ mentions: small, match: small, claims: small, summary: small }, other, "x".repeat(200)).name).toHaveLength(120);
  });

  it("bills a scripted model like a hosted one", async () => {
    const meter = new CappedMeter(1_000_000);
    const llm = new ScriptedLLM().respond("ping", () => ({ ok: true })).bill(meter, price, { input: 1_000, output: 100 });
    await llm.object({ name: "ping", schema: z.object({ ok: z.boolean() }), system: "", prompt: "" });
    expect(meter).toMatchObject({ spent: 1_500, held: 0, calls: 1 });
  });
});
