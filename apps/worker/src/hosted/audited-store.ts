import {
  ACTOR_TRAILER,
  AuditError,
  CONFIG_PATH,
  StoreConflictError,
  VaultError,
  auditChanges,
  parseActorTrailer,
  parseConfig,
  type Actor,
  type Change,
  type CommitMeta,
  type VaultStore,
  type Violation,
} from "@hippocampus/core";
import type { ScribeClient } from "../scribe.ts";
import { checkInbox, type Quotas } from "./quotas.ts";

// Every write a hosted vault makes, checked before it reaches GitHub. A commit names its actor in a
// `Hippo-Actor` trailer; the runtime knows who is really asking (the principal), so a claim the
// principal can't make is refused, and the change set is audited as the claimed actor.

/** Who is really behind a store: the signed-in human, the relay's curator, or an MCP key. */
export type Principal = { kind: "human" } | { kind: "curator" } | { kind: "agent"; agent?: string; scopes: readonly string[] };

/** Reads pinned to one commit, which is the base its writes are computed from. */
export interface PinnedStore extends VaultStore {
  head(): Promise<string>;
}

const COMMIT = "(commit)";

/** The `Hippo-Actor` claims in a commit message's trailer paragraph. */
export function actorClaims(message: string): string[] {
  const body = message.trimEnd();
  // Trailers live in the last paragraph, and the subject is never one.
  const split = body.lastIndexOf("\n\n");
  const trailers = split < 0 ? [] : body.slice(split + 2).split("\n");
  const prefix = `${ACTOR_TRAILER}:`;
  return [...new Set(trailers.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length).trim()))];
}

/**
 * The actor a commit may be audited as, given who's behind it, or the violation that refuses it.
 * Agents get their key's scopes; a bound key's agent can't file under another id.
 */
export function actorFor(message: string, principal: Principal): Actor | Violation {
  const claims = actorClaims(message);
  if (!claims.length) return { path: COMMIT, rule: `missing ${ACTOR_TRAILER} trailer` };
  if (claims.length > 1) return { path: COMMIT, rule: `conflicting ${ACTOR_TRAILER} trailers` };
  const actor = parseActorTrailer(claims[0]!);
  if (!actor) return { path: COMMIT, rule: `unknown ${ACTOR_TRAILER} trailer` };
  if (actor.kind !== principal.kind) return { path: COMMIT, rule: `${principal.kind} may not commit as ${actor.kind}` };
  if (actor.kind === "agent" && principal.kind === "agent") {
    if (principal.agent !== undefined && actor.id !== principal.agent) return { path: COMMIT, rule: "this key is bound to another agent" };
    return { ...actor, scopes: [...principal.scopes] };
  }
  return actor;
}

const isViolation = (v: Actor | Violation): v is Violation => "rule" in v;

export interface AuditedStoreOptions {
  reads: PinnedStore;
  writer: ScribeClient;
  principal: Principal;
  quotas: Pick<Quotas, "pendingEpisodes" | "pendingIntroductions">;
}

/** Reads from a pinned store; each batch is audited and quota-checked, then committed through the single writer. */
export class AuditedStore implements PinnedStore {
  constructor(private readonly o: AuditedStoreOptions) {}

  head(): Promise<string> {
    return this.o.reads.head();
  }

  list(prefix?: string): Promise<string[]> {
    return this.o.reads.list(prefix);
  }

  read(path: string): Promise<string | undefined> {
    return this.o.reads.read(path);
  }

  async refresh(): Promise<void> {
    await this.o.reads.refresh?.();
  }

  async write(): Promise<void> {
    throw new VaultError("the hosted vault writes only in atomic batches (Vault.flush)");
  }

  async remove(): Promise<void> {
    throw new VaultError("the hosted vault writes only in atomic batches (Vault.flush)");
  }

  async apply(changes: Change[], meta: CommitMeta): Promise<void> {
    const { reads, writer, principal } = this.o;
    // The pinned commit is what the caller read, so it's both the audit's "before" and the commit's base.
    const base = await reads.head();
    const actor = actorFor(meta.message, principal);
    if (isViolation(actor)) throw new AuditError([actor]);
    const violations = await auditChanges({ before: reads, changes, actor });
    if (violations.length) throw new AuditError(violations);
    const { inbox } = parseConfig(await reads.read(CONFIG_PATH)).folders;
    checkInbox(await reads.list(inbox), changes, inbox, this.o.quotas);
    const result = await writer.commit({ base, changes, meta });
    if (!result.ok) throw new StoreConflictError(result.conflict);
  }
}
