import { describe, expect, it } from "vitest";
import { GitHubStore, RequestTimeoutError } from "@hippocampus/store-github";
import { FakeGitHub } from "@hippocampus/store-github/testing";
import { ScribeQueue } from "./scribe.ts";

describe("ScribeQueue", () => {
  it("moves on to the next batch when GitHub never answers one", async () => {
    const gh = await FakeGitHub.create({ "goals/residence-permit.md": "# Residence permit\n" });
    let stall = true;
    // The first ref update hangs until its signal aborts it, like a connection that never answers.
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (stall && init?.method === "PATCH") {
        stall = false;
        return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
      }
      return gh.fetch(input, init);
    };
    const store = new GitHubStore({ repo: gh.repo, token: "t", fetch, timeoutMs: 50 });
    const writer = new ScribeQueue(store);
    const base = await store.head();
    const meta = { message: "remember" };
    const first = writer.commit({ base, changes: [{ path: "inbox/residency-agent/a.md", content: "a" }], meta });
    const second = writer.commit({ base, changes: [{ path: "inbox/residency-agent/b.md", content: "b" }], meta });
    await expect(first).rejects.toThrow(RequestTimeoutError);
    await expect(second).resolves.toEqual({ ok: true });
    expect(await new GitHubStore({ repo: gh.repo, token: "t", fetch: gh.fetch }).read("inbox/residency-agent/b.md")).toBe("b");
  });
});
