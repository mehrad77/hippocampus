import type { HippoService } from "@hippocampus/core";
import { describe, expect, it } from "vitest";
import { HUMAN_READ, serviceSource } from "./service-source.ts";

describe("serviceSource", () => {
  it("reads as the human, so they see their own confidential values", async () => {
    const calls: [string, unknown[]][] = [];
    const spy = new Proxy({} as HippoService, {
      get: (_, name: string) =>
        async (...args: unknown[]) => {
          calls.push([name, args]);
          return {};
        },
    });
    const source = serviceSource(spy, { mode: "local", vault: { kind: "memory" } });
    await source.overview();
    await source.catalog();
    await source.graph();
    await source.chronicle("2026-09");
    await source.entity("migration-agency");
    await source.search("agency", 3);
    expect(calls).toEqual([
      ["overview", [HUMAN_READ]],
      ["catalog", [HUMAN_READ]],
      ["graph", [HUMAN_READ]],
      ["chronicle", ["2026-09", HUMAN_READ]],
      ["entityDetail", ["migration-agency", HUMAN_READ]],
      ["search", ["agency", { limit: 3, human: true }]],
    ]);
    expect(HUMAN_READ).toEqual({ human: true });
  });
});
