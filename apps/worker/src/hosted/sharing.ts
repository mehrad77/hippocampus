import { SLUG } from "@hippocampus/core";
import { HttpError, type HostedIncomingInvite, type HostedInvite, type HostedInvites, type HostedMembers, type HostedNewInvite, type HostedVault } from "@hippocampus/dashboard";
import { hostedVault } from "./onboarding.ts";
import { MAX_PENDING_APP_INVITES, type Invite, type MemberVault, type Registry, type Role } from "./registry.ts";
import type { Caller } from "./routes.ts";
import type { HostedSettings } from "./settings.ts";

// Sharing on the hosted app: a vault's members and invites, invites to the app itself, and accepting
// them. Routes and their shapes are in packages/dashboard/src/setup.ts. Who may do what:
//
//   owner    invites, changes roles, removes members, revokes the vault's invites
//   member   acts as their own human on the dashboard; manages their own keys; leaves
//   viewer   reads the dashboard; leaves
//
// Anyone approved (and not stopped by an admin) invites people to the app; accepting any invite
// approves the account that accepts it.

export interface SharingDeps {
  caller: Caller;
  registry: Registry;
  settings: HostedSettings;
  now?: () => Date;
  /** Link (or unlink, `null`) a person's GitHub login to one of the vault's humans, in its config. */
  linkHuman?: (vault: MemberVault, human: string, login: string | null, via: string, create?: { domains?: string[] }) => Promise<void>;
  /** Revoke an account's connector grants for one vault (someone leaving it). */
  revokeVaultGrants?: (accountId: number, vaultId: string) => Promise<void>;
}

/** GitHub's login rule. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const SHARED_ROLES = ["member", "viewer"] as const;

const bad = (msg: string): never => {
  throw new HttpError(400, msg, "INVALID");
};

const field = (body: unknown, name: string): unknown => (body as Record<string, unknown> | undefined)?.[name];

function login(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const l = typeof raw === "string" ? raw.trim().replace(/^@/, "") : "";
  return GITHUB_LOGIN.test(l) ? l : bad("login: a GitHub login, like game-master");
}

function role(raw: unknown): (typeof SHARED_ROLES)[number] {
  return (SHARED_ROLES as readonly unknown[]).includes(raw) ? (raw as (typeof SHARED_ROLES)[number]) : bad("role: member or viewer");
}

const inviteView = (i: Invite): HostedInvite => ({
  id: i.id,
  ...(i.vaultId ? { vault: i.vaultId } : {}),
  ...(i.role ? { role: i.role } : {}),
  ...(i.human ? { human: i.human } : {}),
  ...(i.login ? { login: i.login.login } : {}),
  created: i.created,
  expires: i.expires,
});

export function sharing(deps: SharingDeps) {
  const { caller, registry, settings } = deps;
  const { account } = caller;
  const via = `@${account.login}`;
  const link = (token: string) => `${settings.publicUrl}/dashboard/invite/#${token}`;
  const admin = settings.admins.has(account.id);

  function vaultOf(roles: readonly Role[], what: string): MemberVault {
    const vault = caller.vault;
    if (!vault) throw new HttpError(409, "No vault yet: set one up first.", "NO_VAULT");
    if (!roles.includes(vault.role)) throw new HttpError(403, `Only the vault's owner can ${what}.`, "OWNER_ONLY");
    return vault;
  }

  /** Someone leaves a vault (or is removed): their keys, connector grants and login in its config go. */
  async function unseat(vault: MemberVault, user: string): Promise<void> {
    const gone = await registry.removeMember(vault.id, user);
    if (!gone) throw new HttpError(404, "No such member.", "NOT_FOUND");
    const them = await registry.accountByUser(user);
    if (them) await deps.revokeVaultGrants?.(them.id, vault.id);
    // Their human stays, with its history; only the login that let them in goes. Best effort: the seat is gone either way.
    if (gone.human) await deps.linkHuman?.(vault, gone.human, null, via).catch(() => undefined);
  }

  async function incoming(i: Invite): Promise<HostedIncomingInvite> {
    const from = await registry.accountByUser(i.createdBy);
    const vault = i.vaultId ? await registry.vault(i.vaultId) : undefined;
    return {
      id: i.id,
      from: from?.login ?? "someone",
      ...(vault ? { vault: { id: vault.id, fullName: vault.fullName } } : {}),
      ...(i.role ? { role: i.role } : {}),
      ...(i.human ? { human: i.human } : {}),
      ...(i.login ? { login: i.login.login } : {}),
      expires: i.expires,
    };
  }

  const myLogins = () => registry.identities(account.user);

  /** An invite the caller may act on as its recipient: by token, or by id when it names their login. */
  async function received(body: unknown): Promise<Invite> {
    const token = field(body, "token");
    const id = field(body, "id");
    let invite: Invite | undefined;
    if (typeof token === "string" && token) invite = await registry.inviteForToken(token.trim());
    else if (typeof id === "string" && /^[0-9a-f]{64}$/.test(id)) {
      const found = await registry.invite(id);
      const mine = await myLogins();
      // Without the token, only the person it's addressed to can see it.
      if (found?.login && mine.some((l) => l.provider === found.login!.provider && l.login.toLowerCase() === found.login!.login.toLowerCase())) invite = found;
    } else bad("token or id: which invite");
    if (!invite || !registry.isOpen(invite)) throw new HttpError(410, "This invite was used, revoked, or has expired. Ask for a new one.", "INVITE_GONE");
    return invite;
  }

  return {
    /** `vaults/<sub>` on the vault the request picked. */
    async vaults(method: string, sub: string, body: unknown): Promise<unknown> {
      if (sub === "members" && method === "GET") {
        const vault = vaultOf(["owner", "member", "viewer"], "see its members");
        const members = await registry.members(vault.id);
        const found: HostedMembers = {
          members: members.map((m) => ({ user: m.user, login: m.login, role: m.role, ...(m.human ? { human: m.human } : {}), since: m.since })),
          ...(vault.role === "owner" ? { invites: (await registry.openInvites({ vaultId: vault.id })).map(inviteView) } : {}),
          you: account.user,
        };
        return found;
      }
      if (method !== "POST") throw new HttpError(404, `No such route: ${method} vaults/${sub}`, "NOT_FOUND");
      if (sub === "members/invite") {
        const vault = vaultOf(["owner"], "invite people");
        if (vault.status !== "ready") throw new HttpError(409, "This vault isn't ready.", "NOT_READY");
        const human = typeof field(body, "human") === "string" ? (field(body, "human") as string).trim().toLowerCase() : "";
        if (!SLUG.test(human)) bad("human: who they are in the vault, an id like game-master");
        const domains = field(body, "domains");
        if (domains !== undefined && (!Array.isArray(domains) || domains.length > 30 || domains.some((d) => typeof d !== "string" || !SLUG.test(d)))) bad("domains: up to 30 ids");
        const to = login(field(body, "login"));
        if (to && to.toLowerCase() === account.login.toLowerCase()) bad("login: that's you");
        const taken = (await registry.members(vault.id)).find((m) => m.human === human);
        if (taken) throw new HttpError(409, `@${taken.login} is ${human} in this vault already.`, "HUMAN_TAKEN");
        const { token, invite } = await registry.createInvite({
          vaultId: vault.id,
          role: role(field(body, "role")),
          human,
          ...(Array.isArray(domains) && domains.length ? { domains: domains as string[] } : {}),
          ...(to ? { login: { provider: "github" as const, login: to } } : {}),
          createdBy: account.user,
        });
        const made: HostedNewInvite = { invite: inviteView(invite), link: link(token) };
        return made;
      }
      if (sub === "members/role") {
        const vault = vaultOf(["owner"], "change roles");
        const user = field(body, "user");
        if (typeof user !== "string") bad("user: whose role");
        await registry.setMemberRole(vault.id, user as string, role(field(body, "role")));
        return { ok: true };
      }
      if (sub === "members/remove") {
        const vault = vaultOf(["owner"], "remove people");
        const user = field(body, "user");
        if (typeof user !== "string" || user === account.user) bad("user: someone the vault is shared with");
        await unseat(vault, user as string);
        return { ok: true };
      }
      if (sub === "invites/revoke") {
        const vault = vaultOf(["owner"], "revoke its invites");
        const invite = await registry.invite(String(field(body, "id") ?? ""));
        if (!invite || invite.vaultId !== vault.id) throw new HttpError(404, "No such invite.", "NOT_FOUND");
        await registry.revokeInvite(invite.id);
        return { ok: true };
      }
      if (sub === "leave") {
        const vault = vaultOf(["member", "viewer"], "remove it; the owner removes the vault instead");
        await unseat(vault, account.user);
        return { ok: true };
      }
      throw new HttpError(404, `No such route: ${method} vaults/${sub}`, "NOT_FOUND");
    },

    /** `invites/<sub>`: invites to the app, and accepting any invite. */
    async invites(method: string, sub: string, body: unknown): Promise<unknown> {
      if (sub === "" && method === "GET") {
        const mine = await myLogins();
        const found: HostedInvites = {
          sent: (await registry.openInvites({ createdBy: account.user })).map(inviteView),
          accepted: await registry.acceptedInvites(account.user),
          canInvite: account.status === "approved" && account.canInvite,
          ...(admin ? {} : { limit: MAX_PENDING_APP_INVITES }),
          incoming: await Promise.all((await registry.invitesFor(mine)).filter((i) => i.createdBy !== account.user).map(incoming)),
        };
        return found;
      }
      if (method !== "POST") throw new HttpError(404, `No such route: ${method} invites/${sub}`, "NOT_FOUND");
      if (sub === "") {
        if (account.status !== "approved") throw new HttpError(403, "Your account is waiting for an admin's approval.", "NOT_APPROVED");
        if (!account.canInvite) throw new HttpError(403, "An admin turned off invites for your account.", "INVITES_OFF");
        const to = login(field(body, "login"));
        if (to && to.toLowerCase() === account.login.toLowerCase()) bad("login: that's you");
        const { token, invite } = await registry.createInvite({ createdBy: account.user, ...(to ? { login: { provider: "github" as const, login: to } } : {}) }, { admin });
        const made: HostedNewInvite = { invite: inviteView(invite), link: link(token) };
        return made;
      }
      if (sub === "revoke") {
        const invite = await registry.invite(String(field(body, "id") ?? ""));
        if (!invite || invite.vaultId || invite.createdBy !== account.user) throw new HttpError(404, "No such invite.", "NOT_FOUND");
        await registry.revokeInvite(invite.id);
        return { ok: true };
      }
      if (sub === "peek") return incoming(await received(body));
      if (sub === "decline") {
        const invite = await received(body);
        if (!invite.login) bad("id: an invite addressed to you");
        await registry.revokeInvite(invite.id);
        return { ok: true };
      }
      if (sub === "accept") {
        const invite = await received(body);
        await registry.acceptInvite(invite, account, await myLogins());
        if (!invite.vaultId) return {};
        const now = (await registry.vaultsOf(account)).find((v) => v.id === invite.vaultId);
        if (!now) return {};
        await registry.setLastVault(account.user, now.id);
        // Their login goes onto their human in the vault's config, so local tools and the audit know them too.
        // Best effort: the seat is what gives access, and it's taken.
        if (invite.human) await deps.linkHuman?.(now, invite.human, account.login, via, { domains: invite.domains ?? [] }).catch(() => undefined);
        const vault: HostedVault = hostedVault(now, settings);
        return { vault };
      }
      throw new HttpError(404, `No such route: ${method} invites/${sub}`, "NOT_FOUND");
    },
  };
}
