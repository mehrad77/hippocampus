import { describe, expect, it } from "vitest";
import { logEvent, rateLimit } from "./limits.ts";

describe("rateLimit", () => {
  it("passes without a binding, follows the binding, and fails open when it breaks", async () => {
    expect(await rateLimit(undefined, "account:4242")).toBe(true);
    expect(await rateLimit({ limit: async () => ({ success: false }) }, "account:4242")).toBe(false);
    expect(await rateLimit({ limit: async ({ key }) => ({ success: key === "account:4242" }) }, "account:4242")).toBe(true);
    expect(
      await rateLimit(
        {
          limit: async () => {
            throw new Error("binding down");
          },
        },
        "account:4242",
      ),
    ).toBe(true);
  });
});

describe("logEvent", () => {
  it("logs one JSON line with the vault id hashed and no query", async () => {
    const lines: string[] = [];
    await logEvent({ route: "GET admin/accounts?status=waitlisted", vault: "01JABCDEFGHJKMNPQRSTVWXYZ0", status: 200, ms: 12.6 }, (l) => lines.push(l));
    await logEvent({ route: "POST setup/init", status: 409, code: "HAS_VAULT", ms: 3 }, (l) => lines.push(l));
    const [first, second] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(first).toEqual({ route: "GET admin/accounts", status: 200, ms: 13, vault: expect.stringMatching(/^[0-9a-f]{12}$/) });
    expect(lines[0]).not.toContain("01JABCDEFGHJKMNPQRSTVWXYZ0");
    expect(second).toEqual({ route: "POST setup/init", status: 409, code: "HAS_VAULT", ms: 3 });
  });
});
