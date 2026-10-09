import { describe, expect, it } from "vitest";
import { hostedSettings, type HostedVars } from "./settings.ts";
import { APP, ORIGIN } from "./testing.ts";

const env = (vars: HostedVars = {}): HostedVars => ({
  HIPPO_PUBLIC_URL: ORIGIN,
  HIPPO_ADMINS: "4242, 7",
  GITHUB_APP_ID: APP.id,
  GITHUB_APP_SLUG: APP.slug,
  GITHUB_APP_CLIENT_ID: APP.clientId,
  GITHUB_APP_CLIENT_SECRET: APP.clientSecret,
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
  GITHUB_APP_WEBHOOK_SECRET: APP.webhookSecret,
  ...vars,
});

describe("hostedSettings", () => {
  it("reads the app, the admins and the public origin", () => {
    expect(hostedSettings(env({ HIPPO_PUBLIC_URL: `${ORIGIN}/` }))).toMatchObject({ publicUrl: ORIGIN, appSlug: APP.slug, admins: new Set([4242, 7]), apiUrl: undefined });
  });

  it("takes plain http only on this machine", () => {
    expect(() => hostedSettings(env({ HIPPO_PUBLIC_URL: "http://hippo.test" }))).toThrow("HIPPO_PUBLIC_URL must be an https URL");
    expect(() => hostedSettings(env({ HIPPO_PUBLIC_URL: "ftp://hippo.test" }))).toThrow("HIPPO_PUBLIC_URL");
    for (const local of ["http://127.0.0.1:8787", "http://localhost:8787", "http://[::1]:8787"]) expect(hostedSettings(env({ HIPPO_PUBLIC_URL: local })).publicUrl).toBe(local);
  });

  it("sends GitHub traffic elsewhere only for local development, without echoing the address", () => {
    const fake = { GITHUB_API_URL: "http://127.0.0.1:8786/", GITHUB_OAUTH_URL: "http://127.0.0.1:8786" };
    expect(hostedSettings(env({ HIPPO_PUBLIC_URL: "http://127.0.0.1:8787", ...fake }))).toMatchObject({ apiUrl: "http://127.0.0.1:8786", oauthUrl: "http://127.0.0.1:8786" });
    expect(() => hostedSettings(env(fake))).toThrow("Unset GITHUB_API_URL and GITHUB_OAUTH_URL");
    const err = (() => {
      try {
        hostedSettings(env({ GITHUB_OAUTH_URL: "https://elsewhere.test" }));
      } catch (e) {
        return String(e);
      }
    })();
    expect(err).toContain("Unset GITHUB_OAUTH_URL:");
    expect(err).not.toContain("elsewhere");
    expect(hostedSettings(env({ GITHUB_API_URL: " " })).apiUrl).toBeUndefined();
  });
});
