import { useEffect, useMemo, useState } from "react";
import { ApiError, postJson } from "../lib/api.ts";
import { invalidate, useResource } from "../lib/cache.ts";
import { on, toast } from "../lib/events.ts";
import { fuzzyFilter } from "../lib/fuzzy.ts";
import { useTerms } from "../lib/prefs.ts";
import { useSession } from "../lib/session.ts";
import type { Catalog } from "../lib/types.ts";
import { TypeDot } from "../ui/EntityLink.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Dialog } from "../ui/Parts.tsx";
import { kindLabel } from "../ui/play/model.ts";

// [kind, plain help, codex help]; the labels come from the shared kind names.
const KINDS = [
  ["fact", "Something true: a date, an amount, an address", "Something true: a date, an amount, an address"],
  ["observation", "Something you noticed", "Something you noticed"],
  ["decision", "Something you decided", "Something you decided"],
  ["task", "Progress on a goal", "Progress on a quest"],
  ["question", "Something to find out", "Something to find out"],
  ["beat", "A moment worth recording", "A moment worth narrating"],
] as const;

/** "Scribe a memory" ("Add a note"): the human drops an episode into the inbox. It becomes canon at the next sleep, with the human's authority. */
export function ScribeDialog() {
  const session = useSession();
  const { t, v, look } = useTerms();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<string>("fact");
  const [about, setAbout] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [secret, setSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const canRemember = !!session.data?.capabilities.remember;
  const catalog = useResource<Catalog>(open && canRemember ? "/catalog" : null);

  useEffect(
    () =>
      on("scribe:open", (d) => {
        setAbout(d.about ?? []);
        if (d.kind) setKind(d.kind);
        setOpen(true);
      }),
    [],
  );

  const suggestions = useMemo(
    () => (query.trim() ? fuzzyFilter(catalog.data?.entities ?? [], query, (e) => [e.title, e.slug, ...e.aliases], 6).filter((e) => !about.includes(e.slug)) : []),
    [catalog.data, query, about],
  );
  const titleOf = (slug: string) => catalog.data?.entities.find((e) => e.slug === slug);

  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await postJson("/actions/remember", { text, kind, about: about.map((s) => `[[${s}]]`), secret: secret || undefined });
      toast(
        session.data?.actor?.kind === "agent"
          ? v(`Saved as ${session.data.actor.id}. It's processed at the next nightly update.`, `Filed as ${session.data.actor.id}. It joins canon at the next sleep.`)
          : v("Added to the inbox. It becomes confirmed at the next nightly update, and it outranks what any agent reports.", "Into the satchel. It joins canon at the next sleep, with your authority."),
        "ok",
      );
      setText("");
      setAbout([]);
      setSecret(false);
      close();
      void invalidate((k) => k.startsWith("/overview") || k.startsWith("/entity"));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  };

  if (!canRemember) return null;
  const github = session.data?.vault?.kind === "github" || session.data?.mode === "worker";
  return (
    <Dialog
      open={open}
      onClose={close}
      title={
        <span className="row">
          <Icon name="quill" /> {t("scribe")}
        </span>
      }
      footer={
        <>
          <span className="small muted spacer">
            {v("Saved as ", "Filed as ")}
            <strong>{session.data?.actor?.id ?? "you"}</strong>
            {session.data?.actor?.kind === "human" ? v(" (what you write outranks every agent)", " (your word outranks every agent)") : ""}
          </span>
          <button type="button" className="btn btn--ghost" onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={submit} disabled={busy || !text.trim()}>
            <Icon name="quill" /> {busy ? v("Saving…", "Scribing…") : v("Add note", "Scribe it")}
          </button>
        </>
      }
    >
      <div className="stack">
        <label className="field">
          <span>{v("Note", "The memory")}</span>
          <textarea
            className="textarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={v(
              "One specific fact or event, with exact dates, amounts and names. E.g. “The agency moved my appointment to 14 Oct, 10:30, Alfama office.”",
              "One concrete memory, with exact dates, amounts and names. E.g. “The agency moved my appointment to 14 Oct, 10:30, Alfama office.”",
            )}
            autoFocus
            maxLength={8000}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
            }}
          />
        </label>
        <div className="field">
          <span>{v("Type", "Kind")}</span>
          <div className="row" role="radiogroup" aria-label={v("Type", "Kind")}>
            {KINDS.map(([value, plainHelp, codexHelp]) => (
              <button key={value} type="button" className="chip" role="radio" aria-checked={kind === value} aria-pressed={kind === value} title={v(plainHelp, codexHelp)} onClick={() => setKind(value)}>
                {kindLabel(value, look)}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span>{v("Related to (optional)", "About (optional hints)")}</span>
          <div className="row">
            {about.map((slug) => {
              const e = titleOf(slug);
              return (
                <button key={slug} type="button" className="chip" onClick={() => setAbout((xs) => xs.filter((x) => x !== slug))} title="Remove">
                  <TypeDot type={e?.type ?? "other"} />
                  {e?.title ?? slug} <Icon name="close" size={12} />
                </button>
              );
            })}
            <input className="input" style={{ flex: 1, minWidth: 180 }} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={v("Link a goal, place, person…", "Link a quest, place, person…")} aria-label={v("Find a record to link", "Find an entity to link")} />
          </div>
          {suggestions.length > 0 && (
            <div className="row">
              {suggestions.map((e) => (
                <button
                  key={e.slug}
                  type="button"
                  className="chip"
                  onClick={() => {
                    setAbout((xs) => [...xs, e.slug]);
                    setQuery("");
                  }}
                >
                  <TypeDot type={e.type} /> {e.title}
                </button>
              ))}
            </div>
          )}
        </div>
        <label className="check">
          <input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} />
          Contains an ID, document or account number, or a password
        </label>
        {secret && (
          <div className="callout callout--warn small">
            <Icon name="lock" />
            <div>
              {v("The next nightly update encrypts it into ", "The next sleep encrypts it into ")}
              <code>secrets/</code>
              {v(". Until then it waits in the inbox as plain text, hidden from this dashboard.", "; until then it waits in the inbox in plain text, hidden from this dashboard.")}
              {github && " On a GitHub-backed vault the plain text stays in the repo's history."}
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
