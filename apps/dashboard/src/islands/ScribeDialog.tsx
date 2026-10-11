import { useEffect, useMemo, useState } from "react";
import { ApiError, postJson } from "../lib/api.ts";
import { invalidate, useResource } from "../lib/cache.ts";
import { on, toast } from "../lib/events.ts";
import { fuzzyFilter } from "../lib/fuzzy.ts";
import { useTerms } from "../lib/prefs.ts";
import { useSession } from "../lib/session.ts";
import type { Catalog, FieldView, KindView } from "../lib/types.ts";
import { TypeDot } from "../ui/EntityLink.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Dialog } from "../ui/Parts.tsx";
import { kindLabel } from "../ui/play/model.ts";

// The vault's kinds come from its registry (catalog `kinds`); these stand in until it loads, or for
// a server from before kinds were notes.
const FALLBACK_KINDS: KindView[] = [
  { name: "fact", behaviour: "fact", text: "required", data: {}, description: "Something true: a date, an amount, an address" },
  { name: "observation", behaviour: "observation", text: "required", data: {}, description: "Something you noticed" },
  { name: "decision", behaviour: "decision", text: "required", data: {}, description: "Something you decided" },
  { name: "task", behaviour: "task", text: "required", data: {}, description: "Something to do, or progress on a goal" },
  { name: "question", behaviour: "question", text: "required", data: {}, description: "Something to find out" },
];

const DEFAULT_GIST = 280;

/** Typed `data` from the form's strings: numbers, yes/no, comma-separated lists for `many`. Empty fields are left out. */
export function dataOf(fields: Record<string, FieldView>, raw: Record<string, string>): Record<string, string | number | boolean | (string | number)[]> {
  const out: Record<string, string | number | boolean | (string | number)[]> = {};
  for (const [name, f] of Object.entries(fields)) {
    const value = (raw[name] ?? "").trim();
    if (f.kind === "bool") {
      if (value) out[name] = value === "true";
      continue;
    }
    if (!value) continue;
    const one = (x: string) => (f.kind === "number" && x.trim() !== "" && !Number.isNaN(Number(x)) ? Number(x) : x.trim());
    out[name] = f.many ? value.split(",").map(one).filter((x) => x !== "") : one(value);
  }
  return out;
}

/** Why the note can't be saved yet, or undefined. */
export function scribeProblem(kind: Pick<KindView, "text" | "gistMax" | "data">, text: string, raw: Record<string, string>): string | undefined {
  if (kind.text === "required" && !text.trim()) return "Write the note first.";
  const max = kind.gistMax ?? DEFAULT_GIST;
  if (kind.text === "gist" && text.trim().length > max) return `Keep it to ${max} characters: this kind keeps only a short gist.`;
  for (const [name, f] of Object.entries(kind.data)) if (f.required && !(raw[name] ?? "").trim()) return `Fill in ${name.replace(/_/g, " ")}.`;
  if (kind.text === "forbidden" && !Object.values(raw).some((x) => x.trim())) return "Fill in at least one field.";
  return undefined;
}

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
  const [confidential, setConfidential] = useState(false);
  const [raw, setRaw] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const canRemember = !!session.data?.capabilities.remember;
  // An MCP server from before these inputs refuses them, so they aren't offered (a session from before the flags has both).
  const canConfidential = session.data?.capabilities.confidential !== false;
  const canData = session.data?.capabilities.data !== false;
  const catalog = useResource<Catalog>(open && canRemember ? "/catalog" : null);
  // Aliases (`beat` → observation) stay accepted but aren't offered.
  const registry = catalog.data?.kinds;
  const kinds = (registry?.length ? registry : FALLBACK_KINDS).filter((k) => !k.aliasOf || k.name === kind);
  const current = kinds.find((k) => k.name === kind) ?? registry?.find((k) => k.name === kind) ?? FALLBACK_KINDS[0]!;
  const problem = scribeProblem(canData ? current : { ...current, data: {} }, text, raw);

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
    if (problem) return;
    setBusy(true);
    try {
      const data = canData ? dataOf(current.data, raw) : {};
      await postJson("/actions/remember", {
        ...(current.text !== "forbidden" && text.trim() ? { text } : {}),
        kind,
        ...(Object.keys(data).length ? { data } : {}),
        about: about.map((s) => `[[${s}]]`),
        secret: secret || undefined,
        confidential: (canConfidential && confidential) || undefined,
      });
      toast(
        session.data?.actor?.kind === "agent"
          ? v(`Saved as ${session.data.actor.id}. It's processed at the next nightly update.`, `Filed as ${session.data.actor.id}. It joins canon at the next sleep.`)
          : v("Added to the inbox. It becomes confirmed at the next nightly update, and it outranks what any agent reports.", "Into the satchel. It joins canon at the next sleep, with your authority."),
        "ok",
      );
      setText("");
      setAbout([]);
      setSecret(false);
      setConfidential(false);
      setRaw({});
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
          <button type="button" className="btn btn--primary" onClick={submit} disabled={busy || !!problem} title={problem}>
            <Icon name="quill" /> {busy ? v("Saving…", "Scribing…") : v("Add note", "Scribe it")}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="field">
          <span>{v("Type", "Kind")}</span>
          <div className="row" role="radiogroup" aria-label={v("Type", "Kind")}>
            {kinds.map((k) => (
              <button
                key={k.name}
                type="button"
                className="chip"
                role="radio"
                aria-checked={kind === k.name}
                title={k.description}
                onClick={() => {
                  setKind(k.name);
                  setRaw({});
                }}
              >
                {kindLabel(k.name, registry, look)}
              </button>
            ))}
          </div>
          {current.description && <span className="hint">{current.description}</span>}
        </div>
        {current.text !== "forbidden" && (
          <label className="field">
            <span>
              {v("Note", "The memory")}
              {current.text === "optional" && <span className="muted"> (optional)</span>}
              {current.text === "gist" && <span className="muted"> ({v("a short gist", "a short gist")})</span>}
            </span>
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
            {current.text === "gist" && (
              <span className={`hint${text.trim().length > (current.gistMax ?? DEFAULT_GIST) ? " field-error" : ""}`} aria-live="polite">
                {text.trim().length}/{current.gistMax ?? DEFAULT_GIST} {v("characters: only a gist is kept", "characters: only a gist is kept")}
              </span>
            )}
          </label>
        )}
        {canData && Object.keys(current.data).length > 0 && (
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend>{v("Details", "Particulars")}</legend>
            <div className="stack" style={{ ["--gap" as string]: "8px" }}>
              {Object.entries(current.data).map(([name, f]) => (
                <DataField key={name} name={name} f={f} value={raw[name] ?? ""} onChange={(x) => setRaw((r) => ({ ...r, [name]: x }))} />
              ))}
            </div>
          </fieldset>
        )}
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
        {canConfidential && (
          <label className="check" title={v("Kept out of search, summaries and the agents' views; only agents trusted with it see it", "Kept from the table: out of search, summaries and agents' views")}>
            <input type="checkbox" checked={confidential} onChange={(e) => setConfidential(e.target.checked)} />
            <span>
              <span className="conf" aria-hidden>
                ◐
              </span>{" "}
              {v("Confidential: keep it out of search and other agents' views", "Confidential: keep it from the table")}
            </span>
          </label>
        )}
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

/** One typed `data` field of the chosen kind. */
function DataField({ name, f, value, onChange }: { name: string; f: FieldView; value: string; onChange: (v: string) => void }) {
  const label = (
    <>
      {name.replace(/_/g, " ")}
      {f.required ? <span className="muted"> (required)</span> : null}
    </>
  );
  if (f.kind === "bool")
    return (
      <label className="check" title={f.description}>
        <input type="checkbox" checked={value === "true"} onChange={(e) => onChange(e.target.checked ? "true" : "")} />
        {label}
      </label>
    );
  if (f.kind === "enum" && f.values?.length && !f.many)
    return (
      <label className="field" title={f.description}>
        <span>{label}</span>
        <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {f.values.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      </label>
    );
  const type = f.kind === "number" && !f.many ? "number" : f.kind === "date" && !f.many ? "date" : "text";
  const placeholder = f.many ? "comma-separated" : f.kind === "ref" ? "[[name]]" : f.kind === "enum" ? f.values?.join(", ") : undefined;
  return (
    <label className="field" title={f.description}>
      <span>{label}</span>
      <input className="input" type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} maxLength={500} />
      {f.description && <span className="hint">{f.description}</span>}
    </label>
  );
}
