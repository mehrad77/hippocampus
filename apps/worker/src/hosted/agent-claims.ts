import type { SqlStorageLike } from "@hippocampus/index";

// Which connection each agent name belongs to, in the vault's Durable Object SQLite. A shared key
// ("any agent") names itself on every call; without this it could write as an agent another app is
// connected as, and take on that agent's lane. So the first connection to write as a name holds it:
//
//   a bound key or app (its agent is fixed)   always writes as its agent, and holds the name
//   a shared key                               holds a name nobody holds, or writes as one it holds;
//                                              a name another connection holds is refused
//
// Revoking a connection lets go of its names, but remembers them as released: a released name the
// person made responsible for something (authority on its card) writes canon and reads confidential
// details, so a new connection can't just pick it up. The person hands it over from the Agents page,
// and the next connection to write as it takes it. A name nobody has held yet is first come, first
// served, so an agent the person set up before connecting it still connects by itself.
//
// Reads that name an agent see confidential details only for a name this connection holds (`holds`).

/** An agent name and the connection that holds it (`key:<hash>` or `oauth:<grant>`), since when. */
export interface AgentClaim {
  agent: string;
  credential: string;
  since: string;
}

/** Stand-in holders: a name the person handed over (the next connection takes it), and one whose connection was revoked. */
const HANDED_OVER = "handed-over";
const RELEASED = "released";
const NOBODY = [HANDED_OVER, RELEASED];

/** Whether some connection holds a name, nobody has yet (or it was handed over), or its connection was revoked. */
export type NameState = "held" | "free" | "released";

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
  claim(agent: string, credential: string, bound: boolean, responsible = false): string | undefined {
    const held = this.holder(agent);
    const placeholder = !!held && NOBODY.includes(held.credential);
    if (!bound && held && !placeholder && held.credential !== credential) return `"${agent}" is connected through another app or key; name yourself something else (one id per agent)`;
    if (!bound && held?.credential === RELEASED && responsible) return `"${agent}" is responsible for part of this vault and its app was disconnected; the person can hand the name to this one from the Agents page`;
    if (!held || held.credential !== credential)
      this.sql
        .exec("INSERT INTO agent_claim (agent, credential, bound, since) VALUES (?, ?, ?, ?) ON CONFLICT (agent) DO UPDATE SET credential = excluded.credential, bound = excluded.bound, since = excluded.since", agent, credential, bound ? 1 : 0, this.clock().toISOString())
        .toArray();
    return undefined;
  }

  /** Whether `agent`'s connection was revoked, and nobody has taken the name since. */
  released(agent: string): boolean {
    return this.holder(agent)?.credential === RELEASED;
  }

  /** Where `agent`'s name stands. */
  state(agent: string): NameState {
    const held = this.holder(agent)?.credential;
    return held === RELEASED ? "released" : !held || held === HANDED_OVER ? "free" : "held";
  }

  /** Whether `credential` holds `agent`: then reads naming it are that agent's. */
  holds(agent: string, credential: string): boolean {
    return this.holder(agent)?.credential === credential;
  }

  /** The person lets the next connection that writes as `agent` take the name, whoever holds it now. */
  handOver(agent: string): void {
    this.sql
      .exec("INSERT INTO agent_claim (agent, credential, bound, since) VALUES (?, ?, 0, ?) ON CONFLICT (agent) DO UPDATE SET credential = excluded.credential, bound = 0, since = excluded.since", agent, HANDED_OVER, this.clock().toISOString())
      .toArray();
  }

  /** A connection was revoked: its names are let go, and remembered as released. */
  release(credential: string): number {
    return this.sql.exec("UPDATE agent_claim SET credential = ?, bound = 0, since = ? WHERE credential = ? RETURNING agent", RELEASED, this.clock().toISOString(), credential).toArray().length;
  }

  /** Who holds which name, for showing and tests. Released and handed-over names wait for a holder, so they aren't listed. */
  list(): { agent: string; credential: string; bound: boolean; since: string }[] {
    return (this.sql.exec("SELECT agent, credential, bound, since FROM agent_claim WHERE credential NOT IN (?, ?) ORDER BY agent", HANDED_OVER, RELEASED).toArray() as { agent: string; credential: string; bound: number; since: string }[]).map((r) => ({ ...r, bound: r.bound === 1 }));
  }
}
