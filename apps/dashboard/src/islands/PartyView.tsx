import { useId, useState } from "react";
import "../styles/play.css";
import { postJson } from "../lib/api.ts";
import { useResource } from "../lib/cache.ts";
import { emit, toast } from "../lib/events.ts";
import { plural, titleCase } from "../lib/format.ts";
import { href } from "../lib/routes.ts";
import type { Catalog, Overview, PartyMember, SessionInfo } from "../lib/types.ts";
import { EntityLink } from "../ui/EntityLink.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PageGate } from "../ui/PageGate.tsx";
import { Dialog, Empty, Panel, RelTime, SkeletonPanel } from "../ui/Parts.tsx";
import { errorMessage, settle, useHashTarget } from "../ui/play/actions.ts";
import { PageHead } from "../ui/play/Bits.tsx";
import { agentIdProblem, initials } from "../ui/play/model.ts";

export default function PartyView() {
  return <PageGate>{(session) => <Party session={session} />}</PageGate>;
}

function Party({ session }: { session: SessionInfo }) {
  const { data: o, error } = useResource<Overview>("/overview", { poll: 60_000 });
  const [adding, setAdding] = useState<{ id: string } | null>(null);
  useHashTarget(!!o);
  if (error && !o) return <div className="callout callout--danger">{error.message}</div>;
  if (!o)
    return (
      <div className="grid grid--3">
        <SkeletonPanel lines={7} />
        <SkeletonPanel lines={7} />
        <SkeletonPanel lines={7} />
      </div>
    );

  const human = session.human ?? o.human;
  const canAdd = session.capabilities.party;
  const strangers = o.attention.unknownAgents;
  const members = [...o.party].sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? "") || a.title.localeCompare(b.title));
  return (
    <div className="stack play" style={{ ["--gap" as string]: "28px" }}>
      <PageHead
        kicker={<>The party · {o.campaign}</>}
        title="Character Sheets"
        lede={
          <>
            {o.party.length ? `${plural(o.party.length, "agent")} at the table, and you.` : "Only you at the table so far."} Each sheet says what an agent is trusted with, when you last heard from it, and what it's carrying for the next sleep.
          </>
        }
        action={
          canAdd && (
            <button type="button" className="btn btn--primary" onClick={() => setAdding({ id: "" })}>
              <Icon name="plus" /> Add a member
            </button>
          )
        }
      />

      <ul className="sheets" aria-label="Party members">
        <PlayerSheet o={o} human={human} session={session} />
        {members.map((p) => (
          <MemberSheet key={p.slug} p={p} />
        ))}
      </ul>

      {!o.party.length && (
        <div className="panel">
          <Empty icon="party" title="You're adventuring alone">
            No agents have a party note yet. {canAdd ? "Add one to give it a lane and authority." : "Add a note under party/ in Obsidian to seat one."}
          </Empty>
        </div>
      )}

      {strangers.length > 0 && <Strangers ids={strangers} canAdd={canAdd} onAdd={(id) => setAdding({ id })} />}

      {canAdd && <AddMemberDialog open={!!adding} initialId={adding?.id ?? ""} party={o.party} human={human} onClose={() => setAdding(null)} />}
    </div>
  );
}

// ── Sheets ─────────────────────────────────────────────────────────────────

function PlayerSheet({ o, human, session }: { o: Overview; human: string; session: SessionInfo }) {
  const owned = o.quests.filter((q) => q.owner && q.owner.slug.toLowerCase() === human.toLowerCase());
  return (
    <li className="sheet sheet--player" id="player">
      <header className="sheet__head">
        <span className="sheet__sigil sheet__sigil--player" aria-hidden>
          <Icon name="d20" size={28} />
        </span>
        <div>
          <div className="sheet__class">The Player</div>
          <h2 className="sheet__name">{human}</h2>
          <div className="mono small muted">human · you</div>
        </div>
      </header>
      <p className="sheet__lane">Your word outranks every agent. What you write, scribe or rule becomes canon, and no agent can replace it.</p>
      <dl className="sheet__rows">
        <dt>Authority</dt>
        <dd>
          <span className="chip chip--gold">every domain</span>
        </dd>
        <dt>Rulings</dt>
        <dd>{o.counts.disputes ? <a href={href.page("council")}>{plural(o.counts.disputes, "dispute")} await you</a> : <span className="muted">none waiting</span>}</dd>
        {owned.length > 0 && (
          <>
            <dt>Quests</dt>
            <dd className="sheet__quests">
              {owned.map((q) => (
                <EntityLink key={q.slug} entity={q} />
              ))}
            </dd>
          </>
        )}
      </dl>
      {session.capabilities.remember && (
        <button type="button" className="btn btn--sm sheet__action" onClick={() => emit("scribe:open", {})}>
          <Icon name="quill" size={16} /> Scribe a memory
        </button>
      )}
    </li>
  );
}

function MemberSheet({ p }: { p: PartyMember }) {
  return (
    <li className="sheet" id={p.slug}>
      <header className="sheet__head">
        <span className="sheet__sigil typed typed--party" aria-hidden>
          {initials(p.title)}
        </span>
        <div>
          <div className="sheet__class">Party member</div>
          <h2 className="sheet__name">
            <EntityLink entity={p} />
          </h2>
          <div className="mono small muted">{p.slug}</div>
        </div>
      </header>
      {p.lane ? <p className="sheet__lane">{p.lane}</p> : <p className="sheet__lane muted">No lane written yet. Describe what this agent handles in its party note.</p>}

      <div className="abilities" role="group" aria-label={`${p.title} at a glance`}>
        <a className="ability" href={href.page("satchel", `?agent=${encodeURIComponent(p.slug)}`)} title="Episodes in the satchel, waiting for the next sleep">
          <span className="ability__score">{p.pending}</span>
          <span className="ability__label">waiting</span>
        </a>
        <span className="ability" title="Chronicle entries in the last 30 days">
          <span className="ability__score">{p.chronicled30d}</span>
          <span className="ability__label">chronicled · 30d</span>
        </span>
        <span className="ability" title="Quests this agent owns">
          <span className="ability__score">{p.owns.length}</span>
          <span className="ability__label">{p.owns.length === 1 ? "quest" : "quests"}</span>
        </span>
      </div>

      <dl className="sheet__rows">
        <dt>Authority</dt>
        <dd>
          {p.authority.length ? (
            <span className="row" style={{ ["--gap" as string]: "6px" }}>
              {p.authority.map((d) => (
                <span key={d} className="chip chip--gold" title={`Outranks agents without authority on ${d} entities`}>
                  <Icon name="key" size={12} /> {d}
                </span>
              ))}
            </span>
          ) : (
            <span className="muted">none: its word needs corroboration</span>
          )}
        </dd>
        <dt>Host</dt>
        <dd>{p.host ? <span className="mono">{p.host}</span> : <span className="muted">not recorded</span>}</dd>
        <dt>Last seen</dt>
        <dd>{p.lastSeen ? <RelTime at={p.lastSeen} /> : <span className="muted">not seen yet</span>}</dd>
        {p.owns.length > 0 && (
          <>
            <dt>Quests</dt>
            <dd className="sheet__quests">
              {p.owns.map((q) => (
                <EntityLink key={q.slug} entity={q} />
              ))}
            </dd>
          </>
        )}
      </dl>
    </li>
  );
}

function Strangers({ ids, canAdd, onAdd }: { ids: string[]; canAdd: boolean; onAdd: (id: string) => void }) {
  return (
    <Panel title="Strangers at the door" icon="eye" id="strangers" aside={plural(ids.length, "agent")}>
      <p className="small">These agents write to the inbox or the chronicle but have no party note, so their word counts as rumor until someone corroborates it. Seat them to give them a lane and, if you trust them, authority.</p>
      <ul className="list strangers">
        {ids.map((id) => (
          <li key={id} className="stranger">
            <span className="sheet__sigil sheet__sigil--small" aria-hidden>
              ?
            </span>
            <span className="stranger__who">
              <strong>{titleCase(id)}</strong> <span className="mono small muted">{id}</span>
            </span>
            {canAdd ? (
              <button type="button" className="btn btn--sm" onClick={() => onAdd(id)}>
                <Icon name="plus" size={16} /> Add to the party
              </button>
            ) : (
              <span className="small muted">
                Add <code>party/{id}.md</code> in Obsidian
              </span>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ── Add a member ───────────────────────────────────────────────────────────

function AddMemberDialog({ open, initialId, party, human, onClose }: { open: boolean; initialId: string; party: PartyMember[]; human: string; onClose: () => void }) {
  const catalog = useResource<Catalog>(open ? "/catalog" : null);
  const [seed, setSeed] = useState<string | null>(null);
  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const [lane, setLane] = useState("");
  const [authority, setAuthority] = useState<string[]>([]);
  const [host, setHost] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const ids = { id: useId(), title: useId(), lane: useId(), host: useId(), idErr: useId(), titleErr: useId() };

  // Each opening starts a fresh form, prefilled from the stranger it was opened for.
  const key = open ? initialId : null;
  if (key !== seed) {
    setSeed(key);
    if (open) {
      setId(initialId);
      setTitle(initialId ? titleCase(initialId) : "");
      setLane("");
      setAuthority([]);
      setHost("");
      setTried(false);
    }
  }

  const idProblem = agentIdProblem(id, party.map((p) => p.slug), human);
  const titleProblem = title.trim() ? undefined : "Give it a name for the sheet.";
  const domains = catalog.data?.domains ?? [];
  const slug = id.trim().toLowerCase();

  const submit = async (e?: React.SyntheticEvent) => {
    e?.preventDefault();
    setTried(true);
    if (idProblem || titleProblem) return;
    setBusy(true);
    try {
      const res = await postJson<{ slug: string; path: string }>("/actions/party", {
        id: slug,
        title: title.trim(),
        lane: lane.trim() || undefined,
        authority: authority.length ? authority : undefined,
        host: host.trim() || undefined,
      });
      toast(`Welcome to the party, ${title.trim()}. Wrote ${res.path}.`, "ok");
      onClose();
      void settle();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title={
        <span className="row">
          <Icon name="party" /> Add a party member
        </span>
      }
      footer={
        <>
          <span className="small muted spacer">Written as {human}</span>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="add-member" className="btn btn--primary" disabled={busy}>
            <Icon name="plus" /> {busy ? "Seating…" : "Add to the party"}
          </button>
        </>
      }
    >
      <form id="add-member" className="stack" onSubmit={submit} noValidate>
        <p className="small muted">
          This writes <code>party/{slug && !idProblem ? slug : "<id>"}.md</code>. The agent's id is how it signs its episodes, so it must match what the agent uses.
        </p>
        <div className="field">
          <label htmlFor={ids.id}>Agent id</label>
          <input
            id={ids.id}
            className="input mono"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="e.g. home-finder"
            autoComplete="off"
            spellCheck={false}
            maxLength={63}
            required
            aria-invalid={tried && !!idProblem}
            aria-describedby={ids.idErr}
          />
          <span id={ids.idErr} className={tried && idProblem ? "field-error small" : "hint"}>
            {tried && idProblem ? idProblem : "Lowercase letters, digits and dashes."}
          </span>
        </div>
        <div className="field">
          <label htmlFor={ids.title}>Name on the sheet</label>
          <input id={ids.title} className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Home Finder" maxLength={120} required aria-invalid={tried && !!titleProblem} aria-describedby={tried && titleProblem ? ids.titleErr : undefined} />
          {tried && titleProblem && (
            <span id={ids.titleErr} className="field-error small">
              {titleProblem}
            </span>
          )}
        </div>
        <div className="field">
          <label htmlFor={ids.lane}>Lane (optional)</label>
          <textarea id={ids.lane} className="textarea textarea--short" value={lane} onChange={(e) => setLane(e.target.value)} maxLength={500} placeholder="What it handles, in a sentence. E.g. “Finds and vets flats in Lisbon; talks to landlords.”" />
        </div>
        <div className="field">
          <span>Authority (optional)</span>
          {catalog.error && !catalog.data ? (
            <span className="field-error small">Couldn't load the campaign's domains: {catalog.error.message}</span>
          ) : catalog.loading && !catalog.data ? (
            <span className="hint">Loading the campaign's domains…</span>
          ) : domains.length ? (
            <>
              <div className="row" role="group" aria-label="Authority domains">
                {domains.map((d) => {
                  const on = authority.includes(d);
                  return (
                    <button key={d} type="button" className="chip" aria-pressed={on} onClick={() => setAuthority((xs) => (on ? xs.filter((x) => x !== d) : [...xs, d]))}>
                      {on && <Icon name="check" size={12} />} {d}
                    </button>
                  );
                })}
              </div>
              <span className="hint">On entities of these types or tags, its word outranks agents without authority. Yours still outranks everyone's.</span>
            </>
          ) : (
            <span className="hint">
              No domains are defined in <code>_hippo/config.yaml</code> yet, so it joins without authority.
            </span>
          )}
        </div>
        <div className="field">
          <label htmlFor={ids.host}>Host (optional)</label>
          <input id={ids.host} className="input" value={host} onChange={(e) => setHost(e.target.value)} maxLength={120} placeholder="Where it runs, e.g. a laptop or a server" />
        </div>
      </form>
    </Dialog>
  );
}
