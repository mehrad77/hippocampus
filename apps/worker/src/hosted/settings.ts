// The hosted app's configuration: one GitHub App (sign-in, installs, webhooks) and the admins who
// approve accounts. Everything but the URLs is a Worker secret.

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
  };
}

const trimSlash = (url: string | undefined) => url?.trim().replace(/\/$/, "") || undefined;

/** This machine: where local development and the smoke test run the Worker. */
export const isLoopback = (url: URL) => ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);

export const apiUrlOf = (s: Pick<HostedSettings, "apiUrl">) => s.apiUrl ?? "https://api.github.com";
export const oauthUrlOf = (s: Pick<HostedSettings, "oauthUrl">) => s.oauthUrl ?? "https://github.com";

/** Where a person installs the app (and picks the repo). */
export const installUrl = (s: Pick<HostedSettings, "appSlug" | "oauthUrl">) => `${oauthUrlOf(s)}/apps/${encodeURIComponent(s.appSlug)}/installations/new`;

/** GitHub's new-repo form, prefilled with a private repo named `vault`. */
export const newRepoUrl = (s: Pick<HostedSettings, "oauthUrl">) =>
  `${oauthUrlOf(s)}/new?${new URLSearchParams({ name: "vault", visibility: "private", description: "Hippocampus memory vault" })}`;
