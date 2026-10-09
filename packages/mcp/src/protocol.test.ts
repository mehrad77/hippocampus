import { HippoService } from "@hippocampus/core";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { fixtureStore } from "../../core/src/__fixtures__/vault.ts";
import { createHippoServer } from "./server.ts";

// Contract with clients on different protocol revisions. The SDK (1.30.1) answers `initialize` with the
// version the client asked for when it supports it, and with its latest (2025-11-25) for anything else,
// older or newer; the client then decides whether to go on. Over streamable HTTP, later requests whose
// MCP-Protocol-Version header it doesn't support get a 400. So a client on a newer revision works as long
// as it falls back to 2025-11-25. This test fails when an SDK upgrade changes that.

async function initialize(protocolVersion: string) {
  const server = createHippoServer({ service: new HippoService(fixtureStore()) });
  const [client, transport] = InMemoryTransport.createLinkedPair();
  await server.connect(transport);
  const reply = new Promise<JSONRPCMessage>((resolve) => (client.onmessage = resolve));
  await client.start();
  await client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  const message = (await reply) as { id: number; result?: { protocolVersion: string; serverInfo: { name: string } } };
  await server.close();
  return message;
}

describe("protocol versions", () => {
  it.each(["2025-11-25", "2025-06-18"])("initializes a %s client on its own version", async (version) => {
    expect(await initialize(version)).toMatchObject({ id: 1, result: { protocolVersion: version, serverInfo: { name: "hippocampus" } } });
  });

  it("offers its latest version to a client on a newer one", async () => {
    expect((await initialize("2099-01-01")).result?.protocolVersion).toBe("2025-11-25");
  });
});
