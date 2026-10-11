import type { SqlStorageLike } from "@hippocampus/index";

// Which connection each agent name belongs to, in the vault's Durable Object SQLite. A shared key
// ("any agent") names itself on every call; without this it could write as an agent another app is
// connected as, and take on that agent's lane. So the first connection to write as a name holds it:
//
//   a bound key or app (its agent is fixed)   always writes as its agent, and holds the name
//   a shared key                               holds a name nobody holds, or writes as one it holds;
//                                              a name another connection holds is refused
//
// Revoking a connection lets go of its names.

/** An agent name and the connection that holds it (`key:<hash>` or `oauth:<grant>`), since when. */
export interface AgentClaim {
  agent: string;
  credential: string;
  since: string;
}

const SCHEMA = "CREATE TABLE IF NOT EXISTS agent_claim (agent TEXT PRIMARY KEY, credential TEXT NOT NULL, bound INTEGER NOT NULL, since TEXT NOT NULL)";

export class AgentClaims {
  constructor(
    private readonly sql: SqlStorageLike,
    private readonly clock: () => Date = () => new Date(),
  ) {
    sql.exec(SCHEMA).toArray();
  }

  private holder(agent: string): { credential: string; bound: number } | undefined {
    return this.sql.exec("SELECT credential, bound FROM agent_claim WHERE agent = ?", agent).toArray()[0] as { credential: string; bound: number } | undefined;
  }

  /**
   * May `credential` write as `agent`? Takes the name when it may. Undefined when it may; else the
   * reason it may not, for the refusal.
   */
  claim(agent: string, credential: string, bound: boolean): string | undefined {
    const held = this.holder(agent);
    if (!bound && held && held.credential !== credential) return `"${agent}" is connected through another app or key; name yourself something else (one id per agent)`;
    if (!held || held.credential !== credential)
      this.sql
        .exec("INSERT INTO agent_claim (agent, credential, bound, since) VALUES (?, ?, ?, ?) ON CONFLICT (agent) DO UPDATE SET credential = excluded.credential, bound = excluded.bound, since = excluded.since", agent, credential, bound ? 1 : 0, this.clock().toISOString())
        .toArray();
    return undefined;
  }

  /** A connection was revoked: its names are free again. */
  release(credential: string): number {
    return this.sql.exec("DELETE FROM agent_claim WHERE credential = ? RETURNING agent", credential).toArray().length;
  }

  /** Who holds which name, for showing and tests. */
  list(): { agent: string; credential: string; bound: boolean; since: string }[] {
    return (this.sql.exec("SELECT agent, credential, bound, since FROM agent_claim ORDER BY agent").toArray() as { agent: string; credential: string; bound: number; since: string }[]).map((r) => ({ ...r, bound: r.bound === 1 }));
  }
}
