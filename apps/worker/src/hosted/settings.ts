// The hosted app's configuration: one GitHub App (sign-in, installs, webhooks), the admins who
// approve accounts, and optionally a GitLab OAuth application for vaults on GitLab. Everything
// but the URLs is a Worker secret.

import type { HostedProvider } from "@hippocampus/curator";
import { checkTokenKey } from "./token-box.ts";

export interface HostedSettings {
  /** Public origin of the Worker, e.g. `https://hippocampus.example.workers.dev`. */
  publicUrl: string;
  appId: string;
  /** The app's URL name, for `https://github.com/apps/<slug>/installations/new`. */
  appSlug: string;
  /** The app's OAuth client, for signing people in (user authorization). */
  clientId: string;
  clientSecret: string;
  /** The app's private key, PKCS#8 PEM (`BEGIN PRIVATE KEY`). */
  privateKey: string;
  webhookSecret: string;
  /** GitHub user ids (numbers: logins can be renamed and reused) who approve accounts. */
  admins: Set<number>;
  apiUrl?: string;
  oauthUrl?: string;
  /** Present when the operator set up a GitLab OAuth application: vaults can then live on GitLab. */
  gitlab?: GitLabSettings;
  /** Seals secrets kept in the registry (`HIPPO_TOKEN_KEY`). GitLab needs it, but it can be set without GitLab. */
  tokenKey?: string;
  /**
   * `HIPPO_HOSTED_CURATOR=on`: the operator offers hosted curation. Opt-in, because `HIPPO_TOKEN_KEY` is
   * already set wherever GitLab is: turning it on is a decision (Workers Paid, the eval's models), not a
   * side effect. Unset again, no hosted run starts, and an open one closes at its next alarm.
   */
  hostedCuratorOn?: boolean;
  /** A local fake model provider, per provider (`HIPPO_LLM_ANTHROPIC_URL`, `HIPPO_LLM_MISTRAL_URL`). Loopback Workers only. */
  llmUrls?: Partial<Record<HostedProvider, string>>;
}

/** Whether this instance can curate with an owner's key: the operator turned it on, and it has a key to seal it with. */
export const hostedCurationAvailable = (s: Pick<HostedSettings, "tokenKey" | "hostedCuratorOn">) => !!s.tokenKey && !!s.hostedCuratorOn;

export interface GitLabSettings {
  /** Web origin of the GitLab instance, no trailing slash (default `https://gitlab.com`). */
  url: string;
  clientId: string;
  clientSecret: string;
  /** Seals stored GitLab tokens (`openssl rand -base64 32`). */
  tokenKey: string;
}

export interface HostedVars {
  HIPPO_PUBLIC_URL?: string;
  HIPPO_ADMINS?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_WEBHOOK_SECRET?: string;
  /** Only for local development against a fake GitHub. */
  GITHUB_API_URL?: string;
  GITHUB_OAUTH_URL?: string;
  /** GitLab is optional: all of the client id, secret and token key turn it on. */
  GITLAB_URL?: string;
  GITLAB_CLIENT_ID?: string;
  GITLAB_CLIENT_SECRET?: string;
  HIPPO_TOKEN_KEY?: string;
  /** `off` stops hosted curation (the operator's kill switch). */
  HIPPO_HOSTED_CURATOR?: string;
  /** Only for local development against a fake model provider. */
  HIPPO_LLM_ANTHROPIC_URL?: string;
  HIPPO_LLM_MISTRAL_URL?: string;
}

const REQUIRED = [
  "HIPPO_PUBLIC_URL",
  "HIPPO_ADMINS",
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_WEBHOOK_SECRET",
] as const;

/** The settings the hosted app still needs, for telling the operator what to set. */
export function hostedMissing(env: HostedVars): string[] {
  return REQUIRED.filter((k) => !env[k]?.trim());
}

/** Hosted settings from the Worker's env. Throws, naming what's missing or wrong, rather than run half-configured. */
export function hostedSettings(env: HostedVars): HostedSettings {
  const missing = hostedMissing(env);
  if (missing.length) throw new Error(`The hosted app needs ${missing.join(", ")} (Worker secrets)`);
  const ids = env.HIPPO_ADMINS!.split(/[\s,]+/).filter(Boolean);
  const bad = ids.filter((id) => !/^\d+$/.test(id));
  // Logins can be renamed and then claimed by someone else; the numeric id can't.
  if (bad.length) throw new Error(`HIPPO_ADMINS lists GitHub user ids (numbers), not logins: ${bad.join(", ")}. Find yours at https://api.github.com/users/<login>`);
  const publicUrl = new URL(env.HIPPO_PUBLIC_URL!);
  const local = isLoopback(publicUrl);
  // Over plain http, sign-in cookies lose `Secure` and the `__Host-` prefix.
  if (publicUrl.protocol !== "https:" && !(local && publicUrl.protocol === "http:")) throw new Error("HIPPO_PUBLIC_URL must be an https URL");
  // These send the app's client secret and JWTs elsewhere, so they're for a fake GitHub on this machine only.
  const overrides = (["GITHUB_API_URL", "GITHUB_OAUTH_URL"] as const).filter((k) => env[k]?.trim());
  if (overrides.length && !local) throw new Error(`Unset ${overrides.join(" and ")}: only local development against a fake GitHub uses them`);
  // These would send an owner's model key elsewhere, so they're for a fake provider on this machine only.
  const llm = (["HIPPO_LLM_ANTHROPIC_URL", "HIPPO_LLM_MISTRAL_URL"] as const).filter((k) => env[k]?.trim());
  if (llm.length && !local) throw new Error(`Unset ${llm.join(" and ")}: only local development against a fake model provider uses them`);
  const anthropic = trimSlash(env.HIPPO_LLM_ANTHROPIC_URL);
  const mistral = trimSlash(env.HIPPO_LLM_MISTRAL_URL);
  // Only `on` turns it on; anything else (a typo too) leaves it off, and never stops the app.
  const curator = env.HIPPO_HOSTED_CURATOR?.trim().toLowerCase();
  return {
    publicUrl: publicUrl.origin,
    appId: env.GITHUB_APP_ID!.trim(),
    appSlug: env.GITHUB_APP_SLUG!.trim(),
    clientId: env.GITHUB_APP_CLIENT_ID!.trim(),
    clientSecret: env.GITHUB_APP_CLIENT_SECRET!,
    privateKey: env.GITHUB_APP_PRIVATE_KEY!,
    webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET!,
    admins: new Set(ids.map(Number)),
    apiUrl: trimSlash(env.GITHUB_API_URL),
    oauthUrl: trimSlash(env.GITHUB_OAUTH_URL),
    gitlab: gitlabSettings(env),
    tokenKey: tokenKey(env),
    ...(curator === "on" ? { hostedCuratorOn: true } : {}),
    ...(anthropic || mistral ? { llmUrls: { ...(anthropic ? { anthropic } : {}), ...(mistral ? { mistral } : {}) } } : {}),
  };
}

/** `HIPPO_TOKEN_KEY` when set, checked, so a malformed key fails at startup rather than at the first seal. */
export function tokenKey(env: HostedVars): string | undefined {
  const key = env.HIPPO_TOKEN_KEY?.trim();
  if (!key) return undefined;
  checkTokenKey(key);
  return key;
}

/**
 * The GitLab settings when its client is set; none when it isn't (`HIPPO_TOKEN_KEY` alone seals other
 * secrets); an error for a half-configured client, so a typo doesn't quietly turn GitLab off.
 */
export function gitlabSettings(env: HostedVars): GitLabSettings | undefined {
  const id = env.GITLAB_CLIENT_ID?.trim();
  const secret = env.GITLAB_CLIENT_SECRET?.trim();
  if (!id && !secret) return undefined;
  const key = tokenKey(env);
  const missing = [!id && "GITLAB_CLIENT_ID", !secret && "GITLAB_CLIENT_SECRET", !key && "HIPPO_TOKEN_KEY"].filter(Boolean);
  if (missing.length) throw new Error(`GitLab needs GITLAB_CLIENT_ID, GITLAB_CLIENT_SECRET and HIPPO_TOKEN_KEY together; missing ${missing.join(", ")}`);
  const url = new URL(env.GITLAB_URL?.trim() || "https://gitlab.com");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) throw new Error("GITLAB_URL must be an https URL");
  return { url: url.origin, clientId: id!, clientSecret: secret!, tokenKey: key! };
}

const trimSlash = (url: string | undefined) => url?.trim().replace(/\/$/, "") || undefined;

/** This machine: where local development and the smoke test run the Worker. */
export const isLoopback = (url: URL) => ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);

export const apiUrlOf = (s: Pick<HostedSettings, "apiUrl">) => s.apiUrl ?? "https://api.github.com";
export const oauthUrlOf = (s: Pick<HostedSettings, "oauthUrl">) => s.oauthUrl ?? "https://github.com";

/** Where a person installs the app (and picks the repo). */
export const installUrl = (s: Pick<HostedSettings, "appSlug" | "oauthUrl">) => `${oauthUrlOf(s)}/apps/${encodeURIComponent(s.appSlug)}/installations/new`;

/**
 * An installation's settings on GitHub, where its owner approves new permissions. This is the form for
 * an installation on a personal account; `ActionsApi` switches to /organizations/<org>/ for an organization.
 */
export const installationSettingsUrl = (s: Pick<HostedSettings, "oauthUrl">, installationId: number) => `${oauthUrlOf(s)}/settings/installations/${installationId}`;

/** GitHub's new-repo form, prefilled with a private repo named `vault`. */
export const newRepoUrl = (s: Pick<HostedSettings, "oauthUrl">) =>
  `${oauthUrlOf(s)}/new?${new URLSearchParams({ name: "vault", visibility: "private", description: "Hippocampus memory vault" })}`;
