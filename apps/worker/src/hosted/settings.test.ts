import { describe, expect, it } from "vitest";
import { hostedCurationAvailable, hostedSettings, type HostedVars } from "./settings.ts";
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

  it("takes HIPPO_TOKEN_KEY on its own, without turning GitLab on", () => {
    const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    expect(hostedSettings(env({ HIPPO_TOKEN_KEY: ` ${key} ` }))).toMatchObject({ tokenKey: key, gitlab: undefined });
    expect(hostedSettings(env()).tokenKey).toBeUndefined();
    expect(() => hostedSettings(env({ HIPPO_TOKEN_KEY: "c2hvcnQ=" }))).toThrow("HIPPO_TOKEN_KEY must be 32 bytes");
    expect(hostedSettings(env({ HIPPO_TOKEN_KEY: key, GITLAB_CLIENT_ID: "id", GITLAB_CLIENT_SECRET: "s" })).gitlab).toMatchObject({ clientId: "id", tokenKey: key });
  });

  it("offers hosted curation only when the operator turns it on, and has a token key to seal with", () => {
    const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    // A token key alone (any instance with GitLab has one) doesn't turn it on.
    expect(hostedCurationAvailable(hostedSettings(env({ HIPPO_TOKEN_KEY: key })))).toBe(false);
    expect(hostedCurationAvailable(hostedSettings(env({ HIPPO_TOKEN_KEY: key, HIPPO_HOSTED_CURATOR: " ON " })))).toBe(true);
    expect(hostedCurationAvailable(hostedSettings(env({ HIPPO_HOSTED_CURATOR: "on" })))).toBe(false);
    expect(hostedCurationAvailable(hostedSettings(env({ HIPPO_TOKEN_KEY: key, HIPPO_HOSTED_CURATOR: "off" })))).toBe(false);
    // Anything else leaves it off, and a typo mustn't take the app down.
    expect(hostedSettings(env({ HIPPO_TOKEN_KEY: key, HIPPO_HOSTED_CURATOR: "yes" })).hostedCuratorOn).toBeUndefined();
  });

  it("sends model calls to a fake provider only for local development, without echoing the address", () => {
    const fake = { HIPPO_LLM_ANTHROPIC_URL: "http://127.0.0.1:8788/v1/", HIPPO_LLM_MISTRAL_URL: "http://127.0.0.1:8788/v1" };
    expect(hostedSettings(env({ HIPPO_PUBLIC_URL: "http://127.0.0.1:8787", ...fake })).llmUrls).toEqual({ anthropic: "http://127.0.0.1:8788/v1", mistral: "http://127.0.0.1:8788/v1" });
    expect(() => hostedSettings(env(fake))).toThrow("Unset HIPPO_LLM_ANTHROPIC_URL and HIPPO_LLM_MISTRAL_URL");
    const err = (() => {
      try {
        hostedSettings(env({ HIPPO_LLM_MISTRAL_URL: "https://elsewhere.test" }));
      } catch (e) {
        return String(e);
      }
    })();
    expect(err).toContain("Unset HIPPO_LLM_MISTRAL_URL:");
    expect(err).not.toContain("elsewhere");
    expect(hostedSettings(env()).llmUrls).toBeUndefined();
  });

  it("still refuses a half-configured GitLab client", () => {
    const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    expect(() => hostedSettings(env({ HIPPO_TOKEN_KEY: key, GITLAB_CLIENT_ID: "id" }))).toThrow("missing GITLAB_CLIENT_SECRET");
    expect(() => hostedSettings(env({ GITLAB_CLIENT_ID: "id", GITLAB_CLIENT_SECRET: "s" }))).toThrow("missing HIPPO_TOKEN_KEY");
  });
});
