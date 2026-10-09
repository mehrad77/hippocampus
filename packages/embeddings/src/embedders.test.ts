import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createEmbedder, embedConfigFromEnv, openAICompatibleEmbedder, workersAIEmbedder } from "./embedders.ts";

/** A tiny OpenAI-compatible `/v1/embeddings` server, like LM Studio or Ollama. */
async function server(status = 200) {
  const requests: { model: string; input: string[] }[] = [];
  const srv = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body) as { model: string; input: string[] };
    requests.push(parsed);
    if (status !== 200) return res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "model not loaded" } }));
    const data = parsed.input.map((text, index) => ({ object: "embedding", index, embedding: [text.length, 1, 0] }));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data, model: parsed.model, usage: { prompt_tokens: 1, total_tokens: 1 } }));
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  return { requests, baseURL: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, close: () => srv.close() };
}

describe("embedConfigFromEnv", () => {
  it("is opt-in: no model, no embeddings", () => {
    expect(embedConfigFromEnv({})).toBeUndefined();
    expect(embedConfigFromEnv({ HIPPO_EMBED_PROVIDER: "off", HIPPO_EMBED_MODEL: "x" })).toBeUndefined();
  });

  it("defaults to LM Studio like the curator, and reads the knobs", () => {
    expect(embedConfigFromEnv({ HIPPO_EMBED_MODEL: "text-embedding-bge-m3", HIPPO_EMBED_MIN_SIMILARITY: "0.5" })).toMatchObject({ provider: "lmstudio", model: "text-embedding-bge-m3", minSimilarity: 0.5 });
    expect(embedConfigFromEnv({ HIPPO_EMBED_PROVIDER: "workers-ai" })).toMatchObject({ provider: "workers-ai", model: "@cf/baai/bge-m3" });
    expect(() => embedConfigFromEnv({ HIPPO_EMBED_PROVIDER: "word2vec", HIPPO_EMBED_MODEL: "x" })).toThrow(/unknown/);
  });
});

describe("openAICompatibleEmbedder", () => {
  it("embeds a batch through /v1/embeddings", async () => {
    const srv = await server();
    try {
      const embedder = openAICompatibleEmbedder({ provider: "ollama", model: "nomic-embed-text", baseURL: srv.baseURL });
      expect(embedder.id).toBe("ollama:nomic-embed-text");
      const vecs = await embedder.embed(["Alfama flat", "Lisbon"]);
      expect(vecs.map((v) => [...v])).toEqual([
        [11, 1, 0],
        [6, 1, 0],
      ]);
      expect(srv.requests[0]).toMatchObject({ model: "nomic-embed-text", input: ["Alfama flat", "Lisbon"] });
    } finally {
      srv.close();
    }
  });

  it("surfaces server errors so the index can fall back to keywords", async () => {
    const srv = await server(500);
    try {
      await expect(openAICompatibleEmbedder({ provider: "lmstudio", model: "m", baseURL: srv.baseURL }).embed(["x"])).rejects.toThrow();
    } finally {
      srv.close();
    }
  });
});

describe("workersAIEmbedder", () => {
  it("reads Workers AI's embedding output", async () => {
    const calls: unknown[] = [];
    const ai = { run: async (model: string, input: { text: string[] }) => (calls.push([model, input]), { shape: [1, 2], data: input.text.map(() => [0.5, 0.5]) }) };
    const embedder = createEmbedder({ provider: "workers-ai", model: "@cf/baai/bge-m3" }, { ai });
    expect(embedder.id).toBe("workers-ai:@cf/baai/bge-m3");
    expect((await embedder.embed(["Lisbon"])).map((v) => [...v])).toEqual([[0.5, 0.5]]);
    expect(calls).toEqual([["@cf/baai/bge-m3", { text: ["Lisbon"] }]]);
    await expect(workersAIEmbedder({ run: async () => ({}) }).embed(["x"])).rejects.toThrow(/no embeddings/);
    expect(() => createEmbedder({ provider: "workers-ai", model: "m" })).toThrow(/AI binding/);
  });
});
