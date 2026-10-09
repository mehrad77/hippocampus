import { useId, useState } from "react";
import "../styles/play.css";
import { postJson } from "../lib/api.ts";
import { invalidate, useResource } from "../lib/cache.ts";
import { emit, toast } from "../lib/events.ts";
import { plural, titleCase } from "../lib/format.ts";
import { useTerms } from "../lib/prefs.ts";
import { href } from "../lib/routes.ts";
import type { Catalog, IntroductionDecision, IntroductionResult, IntroductionView, Overview, PartyMember, SessionInfo } from "../lib/types.ts";
import { EntityLink } from "../ui/EntityLink.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PageGate } from "../ui/PageGate.tsx";
import { Dialog, Empty, Panel, RelTime, SkeletonPanel } from "../ui/Parts.tsx";
import { errorMessage, settle, useHashTarget } from "../ui/play/actions.ts";
import { PageHead } from "../ui/play/Bits.tsx";
import { agentIdProblem, initials } from "../ui/play/model.ts";
import { ConfirmDialog, DomainChips, Field } from "./setup/common.tsx";

export default function PartyView() {
  return <PageGate>{(session) => <Party session={session} />}</PageGate>;
}

function Party({ session }: { session: SessionInfo }) {
  const { t, v } = useTerms();
  const { data: o, error } = useResource<Overview>("/overview", { poll: 60_000 });
  const [adding, setAdding] = useState<{ id: string } | null>(null);
  const [approving, setApproving] = useState<IntroductionView | null>(null);
  const [dismissing, setDismissing] = useState<IntroductionView | null>(null);
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
  const intros = o.attention.introductions;
  const members = [...o.party].sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? "") || a.title.localeCompare(b.title));
  return (
    <div className="stack play" style={{ ["--gap" as string]: "28px" }}>
      <PageHead
        kicker={v<React.ReactNode>(o.campaign, <>The party · {o.campaign}</>)}
        title={v(t("party"), "Character Sheets")}
        lede={v(
          <>
            {o.party.length ? `${plural(o.party.length, "agent")}, and you.` : "No agents yet, only you."} Each card shows what an agent is responsible for, when it last sent a note, and how many of its notes wait for the next nightly update.
          </>,
          <>
            {o.party.length ? `${plural(o.party.length, "agent")} at the table, and you.` : "Only you at the table so far."} Each sheet says what an agent is trusted with, when you last heard from it, and what it's carrying for the next sleep.
          </>,
        )}
        action={
          canAdd && (
            <button type="button" className="btn btn--primary" onClick={() => setAdding({ id: "" })}>
              <Icon name="plus" /> {v("Add an agent", "Add a member")}
            </button>
          )
        }
      />

      <ul className="sheets" aria-label={v("Agents", "Party members")}>
        <PlayerSheet o={o} human={human} session={session} />
        {members.map((p) => (
          <MemberSheet key={p.slug} p={p} />
        ))}
      </ul>

      {!o.party.length && (
        <div className="panel">
          <Empty icon="party" title={v("No agents yet", "You're adventuring alone")}>
            {canAdd
              ? v("No agents are set up yet. Add one to say what it's responsible for.", "No agents have a party note yet. Add one to give it a lane and authority.")
              : v("No agents are set up yet. Add a note under party/ in Obsidian to set one up.", "No agents have a party note yet. Add a note under party/ in Obsidian to seat one.")}
          </Empty>
        </div>
      )}

      {intros.length > 0 && <Introductions items={intros} canDecide={session.capabilities.introductions} onApprove={setApproving} onDismiss={setDismissing} />}

      {strangers.length > 0 && <Strangers ids={strangers} canAdd={canAdd} onAdd={(id) => setAdding({ id })} />}

      {canAdd && <AddMemberDialog open={!!adding} initialId={adding?.id ?? ""} party={o.party} human={human} onClose={() => setAdding(null)} />}
      {session.capabilities.introductions && (
        <>
          <ApproveDialog intro={approving} human={human} onClose={() => setApproving(null)} />
          <DismissDialog intro={dismissing} onClose={() => setDismissing(null)} />
        </>
      )}
    </div>
  );
}

// ── Sheets ─────────────────────────────────────────────────────────────────

function PlayerSheet({ o, human, session }: { o: Overview; human: string; session: SessionInfo }) {
  const { t, v } = useTerms();
  const owned = o.quests.filter((q) => q.owner && q.owner.slug.toLowerCase() === human.toLowerCase());
  return (
    <li className="sheet sheet--player" id="player">
      <header className="sheet__head">
        <span className="sheet__sigil sheet__sigil--player" aria-hidden>
          <Icon name="d20" size={28} />
        </span>
        <div>
          <div className="sheet__class">{v("You", "The Player")}</div>
          <h2 className="sheet__name">{human}</h2>
          <div className="mono small muted">{v("a person, not an agent", "human · you")}</div>
        </div>
      </header>
      <p className="sheet__lane">{v("What you write outranks every agent. Anything you write, add or decide becomes confirmed, and no agent can replace it.", "Your word outranks every agent. What you write, scribe or rule becomes canon, and no agent can replace it.")}</p>
      <dl className="sheet__rows">
        <dt>{v("Responsible for", "Authority")}</dt>
        <dd>
          <span className="chip chip--gold">{v("everything", "every domain")}</span>
        </dd>
        <dt>{v("Decisions", "Rulings")}</dt>
        <dd>
          {o.counts.disputes ? (
            <a href={href.page("council")}>{v(`${plural(o.counts.disputes, "dispute")} need${o.counts.disputes === 1 ? "s" : ""} you`, `${plural(o.counts.disputes, "dispute")} await you`)}</a>
          ) : (
            <span className="muted">none waiting</span>
          )}
        </dd>
        {owned.length > 0 && (
          <>
            <dt>{v("Goals", "Quests")}</dt>
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
          <Icon name="quill" size={16} /> {t("scribe")}
        </button>
      )}
    </li>
  );
}

function MemberSheet({ p }: { p: PartyMember }) {
  const { v } = useTerms();
  return (
    <li className="sheet" id={p.slug}>
      <header className="sheet__head">
        <span className="sheet__sigil typed typed--party" aria-hidden>
          {initials(p.title)}
        </span>
        <div>
          <div className="sheet__class">{v("Agent", "Party member")}</div>
          <h2 className="sheet__name">
            <EntityLink entity={p} />
          </h2>
          <div className="mono small muted">{p.slug}</div>
        </div>
      </header>
      {p.lane ? (
        <p className="sheet__lane">{p.lane}</p>
      ) : (
        <p className="sheet__lane muted">{v("No description yet. Describe what this agent handles in its agent note.", "No lane written yet. Describe what this agent handles in its party note.")}</p>
      )}

      <div className="abilities" role="group" aria-label={`${p.title} at a glance`}>
        <a className="ability" href={href.page("satchel", `?agent=${encodeURIComponent(p.slug)}`)} title={v("Notes in the inbox, waiting for the next nightly update", "Episodes in the satchel, waiting for the next sleep")}>
          <span className="ability__score">{p.pending}</span>
          <span className="ability__label">waiting</span>
        </a>
        <span className="ability" title={v("Timeline entries in the last 30 days", "Chronicle entries in the last 30 days")}>
          <span className="ability__score">{p.chronicled30d}</span>
          <span className="ability__label">{v("processed · 30 days", "chronicled · 30d")}</span>
        </span>
        <span className="ability" title={v("Goals this agent owns", "Quests this agent owns")}>
          <span className="ability__score">{p.owns.length}</span>
          <span className="ability__label">{p.owns.length === 1 ? v("goal", "quest") : v("goals", "quests")}</span>
        </span>
      </div>

      <dl className="sheet__rows">
        <dt>{v("Responsible for", "Authority")}</dt>
        <dd>
          {p.authority.length ? (
            <span className="row" style={{ ["--gap" as string]: "6px" }}>
              {p.authority.map((d) => (
                <span key={d} className="chip chip--gold" title={v(`Outranks agents that aren't responsible for ${d} records`, `Outranks agents without authority on ${d} entities`)}>
                  <Icon name="key" size={12} /> {d}
                </span>
              ))}
            </span>
          ) : (
            <span className="muted">{v("nothing yet: its facts need confirmation from another source", "none: its word needs corroboration")}</span>
          )}
        </dd>
        <dt>Host</dt>
        <dd>{p.host ? <span className="mono">{p.host}</span> : <span className="muted">not recorded</span>}</dd>
        <dt>Last seen</dt>
        <dd>{p.lastSeen ? <RelTime at={p.lastSeen} /> : <span className="muted">not seen yet</span>}</dd>
        {p.owns.length > 0 && (
          <>
            <dt>{v("Goals", "Quests")}</dt>
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
  const { v } = useTerms();
  return (
    <Panel title={v("Unknown agents", "Strangers at the door")} icon="eye" id="strangers" aside={plural(ids.length, "agent")}>
      <p className="small">
        {v(
          "These agents send notes but aren't set up as agents, so their facts stay unverified until another source confirms them. Add them to describe what they handle and, if you trust them, which areas they're responsible for.",
          "These agents write to the inbox or the chronicle but have no party note, so their word counts as rumor until someone corroborates it. Seat them to give them a lane and, if you trust them, authority.",
        )}
      </p>
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
                <Icon name="plus" size={16} /> {v("Add as an agent", "Add to the party")}
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

// ── Introductions ─────────────────────────────────────────────────────────

/** `POST actions/introduction`, then refetch everything that shows the party. */
async function decide(body: IntroductionDecision): Promise<IntroductionResult> {
  const res = await postJson<IntroductionResult>("/actions/introduction", body);
  void invalidate((k) => ["/overview", "/catalog", "/entity", "/graph", "/setup"].some((p) => k.startsWith(p)));
  return res;
}

function Introductions({ items, canDecide, onApprove, onDismiss }: { items: IntroductionView[]; canDecide: boolean; onApprove: (i: IntroductionView) => void; onDismiss: (i: IntroductionView) => void }) {
  const { t, v } = useTerms();
  return (
    <Panel title={t("introductions")} icon="party" id="introductions" aside={plural(items.length, "agent")}>
      <p className="small">
        {v(
          "These agents introduced themselves and are waiting for you. Until you approve one, what it reports stays unverified. Approving adds it as an agent, with the areas you choose.",
          "These agents knocked and wait for your word. Until you seat one, its word counts as rumor. Seating it writes its party note, with the authority you choose.",
        )}
      </p>
      <ul className="list strangers">
        {items.map((i) => (
          <li key={i.agent} className="stranger">
            <span className="sheet__sigil sheet__sigil--small" aria-hidden>
              {initials(i.title)}
            </span>
            {/* Everything but the id is the agent's own text: shown as plain text, never markup. */}
            <span className="stranger__who stack" style={{ ["--gap" as string]: "2px" }}>
              <span>
                <strong>{i.title}</strong> <span className="mono small muted">{i.agent}</span>
              </span>
              {i.lane && <span className="small">{i.lane}</span>}
              {i.about && <span className="small pre-line">{i.about}</span>}
              <span className="small muted">
                {i.host && <>runs in {i.host} · </>}
                {i.model && <>{i.model} · </>}
                asked <RelTime at={i.at} />
              </span>
            </span>
            {canDecide ? (
              <span className="row">
                <button type="button" className="btn btn--sm btn--primary" onClick={() => onApprove(i)}>
                  <Icon name="check" size={16} /> {t("approve")}…
                </button>
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => onDismiss(i)}>
                  <Icon name="close" size={16} /> {t("dismiss")}…
                </button>
              </span>
            ) : (
              <span className="small muted">
                {v("To approve it, add ", "To seat it, add ")}
                <code>party/{i.agent}.md</code> in Obsidian
              </span>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function ApproveDialog({ intro, human, onClose }: { intro: IntroductionView | null; human: string; onClose: () => void }) {
  const { t, v } = useTerms();
  const open = !!intro;
  const catalog = useResource<Catalog>(open ? "/catalog" : null);
  const [seed, setSeed] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [lane, setLane] = useState("");
  const [authority, setAuthority] = useState<string[]>([]);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);

  // Each opening starts from what the agent asked for, with no authority until the human ticks some.
  const key = intro?.agent ?? null;
  if (key !== seed) {
    setSeed(key);
    if (intro) {
      setTitle(intro.title);
      setLane(intro.lane ?? "");
      setAuthority([]);
      setTried(false);
    }
  }

  const titleProblem = title.trim() ? undefined : v("Enter a display name.", "Give it a name for the sheet.");
  const domains = catalog.data?.domains ?? [];

  const submit = async (e?: React.SyntheticEvent) => {
    e?.preventDefault();
    setTried(true);
    if (!intro || titleProblem) return;
    setBusy(true);
    try {
      // An emptied lane is sent as "" so it clears what the agent asked for.
      const res = await decide({ agent: intro.agent, decision: "approve", title: title.trim(), lane: lane.trim(), authority });
      toast(v(`Approved ${title.trim()} as an agent.`, `${title.trim()} takes a seat at the table.`) + (res.decision === "approve" ? ` ${v("Saved", "Wrote")} ${res.path}.` : ""), "ok");
      onClose();
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
          <Icon name="party" /> {v(`Approve ${intro?.title ?? "agent"}`, `Seat ${intro?.title ?? "the newcomer"}`)}
        </span>
      }
      footer={
        <>
          <span className="small muted spacer">Written as {human}</span>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="approve-introduction" className="btn btn--primary" disabled={busy}>
            <Icon name="check" /> {busy ? v("Approving…", "Seating…") : t("approve")}
          </button>
        </>
      }
    >
      <form id="approve-introduction" className="stack" onSubmit={submit} noValidate>
        <p className="small muted">
          {v("This creates ", "This writes ")}
          <code>party/{intro?.agent}.md</code>
          {v(", signed by you, and removes the introduction. The agent asked for the name and description below; change them as you like.", ", signed by you, and tears up the introduction. The name and lane are what it asked for; change them as you like.")}
        </p>
        <Field label={v("Display name", "Name on the sheet")} problem={tried ? titleProblem : undefined}>
          {(f) => <input id={f.id} className="input" value={title} onChange={(e) => setTitle(e.target.value)} aria-describedby={f.describedBy} aria-invalid={f.invalid} maxLength={120} required />}
        </Field>
        <Field label={v("What it handles (optional)", "Lane (optional)")}>
          {(f) => <textarea id={f.id} className="textarea textarea--short" value={lane} onChange={(e) => setLane(e.target.value)} aria-describedby={f.describedBy} maxLength={500} />}
        </Field>
        <div className="field">
          <span>{v("Responsible for (optional)", "Authority (optional)")}</span>
          {catalog.error && !catalog.data ? (
            <span className="field-error small">
              {v("Couldn't load the areas: ", "Couldn't load the campaign's domains: ")}
              {catalog.error.message}
            </span>
          ) : catalog.loading && !catalog.data ? (
            <span className="hint">{v("Loading the areas…", "Loading the campaign's domains…")}</span>
          ) : domains.length ? (
            <>
              <DomainChips domains={domains} value={authority} onChange={setAuthority} label={v("Areas it's responsible for", "Authority domains")} />
              <span className="hint">
                {v(
                  "None is the safe default: its facts stay unverified until another source confirms them. For records of the areas you tick, its facts outrank agents that aren't responsible for them.",
                  "None is the safe default: its word stays a rumor until corroborated. On entities of the domains you tick, its word outranks agents without authority.",
                )}
              </span>
            </>
          ) : (
            <span className="hint">
              {v("No areas are defined in ", "No domains are defined in ")}
              <code>_hippo/config.yaml</code>
              {v(" yet, so it's added without any.", " yet, so it joins without authority.")}
            </span>
          )}
        </div>
      </form>
    </Dialog>
  );
}

function DismissDialog({ intro, onClose }: { intro: IntroductionView | null; onClose: () => void }) {
  const { t, v } = useTerms();
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    if (!intro) return;
    setBusy(true);
    try {
      await decide({ agent: intro.agent, decision: "dismiss" });
      toast(v(`Dismissed ${intro.title}'s request.`, `${intro.title} was turned away.`), "ok");
      onClose();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog open={!!intro} title={v(`Dismiss ${intro?.title ?? "this agent"}?`, `Turn ${intro?.title ?? "this newcomer"} away?`)} confirmLabel={t("dismiss")} danger busy={busy} onConfirm={() => void confirm()} onClose={() => !busy && onClose()}>
      <p>
        {v(
          "This removes its request to join. It can still send notes, but what it reports stays unverified, and it can ask again.",
          "This tears up its introduction. It can still file memories, but its word stays a rumor, and it may knock again.",
        )}
      </p>
    </ConfirmDialog>
  );
}

// ── Add a member ───────────────────────────────────────────────────────────

function AddMemberDialog({ open, initialId, party, human, onClose }: { open: boolean; initialId: string; party: PartyMember[]; human: string; onClose: () => void }) {
  const { v, look } = useTerms();
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

  const idProblem = agentIdProblem(id, party.map((p) => p.slug), human, look);
  const titleProblem = title.trim() ? undefined : v("Enter a display name.", "Give it a name for the sheet.");
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
      toast(v(`Added ${title.trim()} as an agent. Saved ${res.path}.`, `Welcome to the party, ${title.trim()}. Wrote ${res.path}.`), "ok");
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
          <Icon name="party" /> {v("Add an agent", "Add a party member")}
        </span>
      }
      footer={
        <>
          <span className="small muted spacer">Written as {human}</span>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="add-member" className="btn btn--primary" disabled={busy}>
            <Icon name="plus" /> {busy ? v("Adding…", "Seating…") : v("Add agent", "Add to the party")}
          </button>
        </>
      }
    >
      <form id="add-member" className="stack" onSubmit={submit} noValidate>
        <p className="small muted">
          {v("This creates ", "This writes ")}
          <code>party/{slug && !idProblem ? slug : "<id>"}.md</code>
          {v(". The agent ID is how it signs its notes, so it must match the ID the agent uses.", ". The agent's id is how it signs its episodes, so it must match what the agent uses.")}
        </p>
        <div className="field">
          <label htmlFor={ids.id}>{v("Agent ID", "Agent id")}</label>
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
          <label htmlFor={ids.title}>{v("Display name", "Name on the sheet")}</label>
          <input id={ids.title} className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Home Finder" maxLength={120} required aria-invalid={tried && !!titleProblem} aria-describedby={tried && titleProblem ? ids.titleErr : undefined} />
          {tried && titleProblem && (
            <span id={ids.titleErr} className="field-error small">
              {titleProblem}
            </span>
          )}
        </div>
        <div className="field">
          <label htmlFor={ids.lane}>{v("What it handles (optional)", "Lane (optional)")}</label>
          <textarea
            id={ids.lane}
            className="textarea textarea--short"
            value={lane}
            onChange={(e) => setLane(e.target.value)}
            maxLength={500}
            placeholder={v("One sentence. E.g. “Finds and checks flats in Lisbon; talks to landlords.”", "What it handles, in a sentence. E.g. “Finds and vets flats in Lisbon; talks to landlords.”")}
          />
        </div>
        <div className="field">
          <span>{v("Responsible for (optional)", "Authority (optional)")}</span>
          {catalog.error && !catalog.data ? (
            <span className="field-error small">
              {v("Couldn't load the areas: ", "Couldn't load the campaign's domains: ")}
              {catalog.error.message}
            </span>
          ) : catalog.loading && !catalog.data ? (
            <span className="hint">{v("Loading the areas…", "Loading the campaign's domains…")}</span>
          ) : domains.length ? (
            <>
              <div className="row" role="group" aria-label={v("Areas it's responsible for", "Authority domains")}>
                {domains.map((d) => {
                  const on = authority.includes(d);
                  return (
                    <button key={d} type="button" className="chip" aria-pressed={on} onClick={() => setAuthority((xs) => (on ? xs.filter((x) => x !== d) : [...xs, d]))}>
                      {on && <Icon name="check" size={12} />} {d}
                    </button>
                  );
                })}
              </div>
              <span className="hint">
                {v(
                  "For records of these types or tags, its facts outrank agents that aren't responsible for them. Yours still outrank everyone's.",
                  "On entities of these types or tags, its word outranks agents without authority. Yours still outranks everyone's.",
                )}
              </span>
            </>
          ) : (
            <span className="hint">
              {v("No areas are defined in ", "No domains are defined in ")}
              <code>_hippo/config.yaml</code>
              {v(" yet, so it's added without any.", " yet, so it joins without authority.")}
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
