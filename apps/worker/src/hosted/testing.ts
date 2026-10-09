import { readFileSync } from "node:fs";
import type { SqlDriver } from "@hippocampus/index";
import { nodeSqlite } from "@hippocampus/index/node";
import { FakeGitHub } from "@hippocampus/store-github/testing";
import { base64url } from "../github-login.ts";
import type { HostedSettings } from "./settings.ts";

// Test helpers for the hosted app: the registry on node:sqlite, a GitHub App key pair, and
// GitHub's sign-in endpoints in front of a FakeGitHub.

export const ORIGIN = "https://hippo.test";
export const APP = { id: "4321", slug: "hippocampus-test", clientId: "Iv1.hosted", clientSecret: "app-secret", webhookSecret: "hook-secret" };

/** The registry, migrated from the same SQL file wrangler applies to D1. */
export async function registryDb(): Promise<SqlDriver> {
  const db = nodeSqlite(":memory:");
  const sql = readFileSync(new URL("../../migrations/0001_registry.sql", import.meta.url), "utf8");
  const statements = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  await db.batch(statements.map((s) => ({ sql: s })));
  return db;
}

const pem = (label: string, der: ArrayBuffer) =>
  `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...new Uint8Array(der)))
    .match(/.{1,64}/g)!
    .join("\n")}\n-----END ${label}-----\n`;

/** A fresh RSA key pair, the private half as PKCS#8 PEM like the app's secret. */
export async function appKeyPair() {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, [
    "sign",
    "verify",
  ])) as { privateKey: Parameters<typeof crypto.subtle.exportKey>[1]; publicKey: Parameters<typeof crypto.subtle.verify>[1] };
  return { privateKeyPem: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)), publicKey: pair.publicKey };
}

const decodeSegment = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** Whether `jwt` is the app's: signed with `publicKey`, issued by `appId`, and current at `now`. */
export async function checkAppJwt(jwt: string, publicKey: Parameters<typeof crypto.subtle.verify>[1], appId: string, now = new Date()): Promise<boolean> {
  const [header, payload, signature] = jwt.split(".");
  if (!header || !payload || !signature) return false;
  const signed = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, decodeSegment(signature), new TextEncoder().encode(`${header}.${payload}`));
  const claims = JSON.parse(new TextDecoder().decode(decodeSegment(payload))) as { iss?: string; iat?: number; exp?: number };
  const t = now.getTime() / 1000;
  return signed && claims.iss === appId && (claims.iat ?? Infinity) <= t && (claims.exp ?? 0) > t;
}

const s256 = async (v: string) => base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));

/**
 * GitHub for the hosted app: `FakeGitHub` for the API, plus the app's OAuth endpoint, which
 * checks the client secret, PKCE (when the code was PKCE-bound) and the redirect URI, and issues
 * user tokens the fake's `/user` endpoints recognize.
 */
export async function hostedGitHub(keys: { publicKey: Parameters<typeof crypto.subtle.verify>[1] }) {
  const gh = await FakeGitHub.create({}, { repo: "player/vault", empty: true, id: 9001 });
  gh.requireAuth = true;
  gh.verifyAppJwt = (jwt) => checkAppJwt(jwt, keys.publicKey, APP.id, gh.now());
  const codes = new Map<string, { login: string; challenge?: string; redirectUri?: string }>();
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.href !== "https://github.test/login/oauth/access_token") return gh.fetch(input, init);
    const body = JSON.parse(String(init?.body)) as Record<string, string | undefined>;
    const grant = codes.get(body.code ?? "");
    codes.delete(body.code ?? "");
    const ok =
      grant &&
      body.client_id === APP.clientId &&
      body.client_secret === APP.clientSecret &&
      (!grant.redirectUri || body.redirect_uri === grant.redirectUri) &&
      (grant.challenge ? !!body.code_verifier && (await s256(body.code_verifier)) === grant.challenge : true);
    if (!ok) return Response.json({ error: "bad_verification_code" });
    const token = `ghu_${crypto.randomUUID()}`;
    gh.tokens.set(token, { user: grant.login });
    return Response.json({ access_token: token, token_type: "bearer", scope: "" });
  };
  /** `login` approves the sign-in at GitHub, which redirects back with a code. */
  const signIn = (authorizeUrl: string, login: string) => {
    const u = new URL(authorizeUrl);
    const code = `gh-${crypto.randomUUID()}`;
    const redirectUri = u.searchParams.get("redirect_uri")!;
    codes.set(code, { login, challenge: u.searchParams.get("code_challenge")!, redirectUri });
    return `${redirectUri}?code=${code}&state=${u.searchParams.get("state")}`;
  };
  /** `login` installs the app (installation `id`) and GitHub redirects to the callback, with a code since user authorization during install is on. */
  const installed = (login: string, id: number, opts: { code?: boolean; action?: string } = {}) => {
    const code = `gh-${crypto.randomUUID()}`;
    codes.set(code, { login });
    const q = new URLSearchParams({ installation_id: String(id), setup_action: opts.action ?? "install", ...(opts.code === false ? {} : { code }) });
    return `${ORIGIN}/oauth/github/callback?${q}`;
  };
  return { gh, fetch, signIn, installed };
}

export function testSettings(privateKey: string, admins: number[] = []): HostedSettings {
  return {
    publicUrl: ORIGIN,
    appId: APP.id,
    appSlug: APP.slug,
    clientId: APP.clientId,
    clientSecret: APP.clientSecret,
    privateKey,
    webhookSecret: APP.webhookSecret,
    admins: new Set(admins),
    apiUrl: "https://api.github.test",
    oauthUrl: "https://github.test",
  };
}
