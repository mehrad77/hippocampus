import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { extractJson, pingLLM } from "./llm.ts";

/** A one-route OpenAI-compatible server on a random loopback port. */
async function fakeServer(handle: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handle(req, res, body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { baseURL: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const completion = (content: string) =>
  JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 0,
    model: "qwen/qwen3.5-9b",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });

describe("extractJson", () => {
  it("finds JSON inside prose and code fences", () => {
    expect(extractJson('Sure!\n```json\n{"a": {"b": "}"}}\n```')).toEqual({ a: { b: "}" } });
    expect(extractJson('\n\n{"entities": []}')).toEqual({ entities: [] });
  });

  it("skips invalid candidates and returns undefined when there is none", () => {
    expect(extractJson('{not json} then {"ok": true}')).toEqual({ ok: true });
    expect(extractJson("no json here")).toBeUndefined();
  });
});

describe("pingLLM", () => {
  it("makes one schema-validated call and reports the model and latency", async () => {
    const requests: string[] = [];
    let sent = "";
    const srv = await fakeServer((req, res, body) => {
      requests.push(`${req.method} ${req.url}`);
      sent = body;
      res.writeHead(200, { "content-type": "application/json" }).end(completion('Sure: {"ok": true}'));
    });
    try {
      const r = await pingLLM({ provider: "lmstudio", model: "qwen/qwen3.5-9b", baseURL: srv.baseURL });
      expect(r).toMatchObject({ ok: true, model: "qwen/qwen3.5-9b" });
      expect(r.ms).toBeGreaterThanOrEqual(0);
      expect(requests).toEqual(["POST /v1/chat/completions"]);
      expect((JSON.parse(sent) as { model: string }).model).toBe("qwen/qwen3.5-9b");
    } finally {
      await srv.close();
    }
  });

  it("reports a wrong answer, an unreachable server and a timeout without throwing", async () => {
    const wrong = await fakeServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(completion('{"ok": false}')));
    const silent = await fakeServer(() => {});
    try {
      expect(await pingLLM({ provider: "ollama", model: "m", baseURL: wrong.baseURL })).toMatchObject({ ok: false, error: expect.stringContaining("not with ok") });
      const timedOut = await pingLLM({ provider: "openai-compatible", model: "m", baseURL: silent.baseURL }, { timeoutMs: 150 });
      expect(timedOut.ok).toBe(false);
      expect(timedOut.error).toBeTruthy();
    } finally {
      await wrong.close();
      await silent.close().catch(() => {});
    }
    const down = await pingLLM({ provider: "lmstudio", model: "m", baseURL: wrong.baseURL }, { timeoutMs: 2000 });
    expect(down).toMatchObject({ ok: false, model: "m" });
    expect(down.error).toBeTruthy();
  });
});
