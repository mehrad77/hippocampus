import { MemoryStore, Vault, fold, parseDoc, type FactValue } from "@hippocampus/core";
import type { EvalCase } from "./cases.ts";
import type { Observation } from "./harness.ts";

// Scores one case's night against its gold: per step from the calls, and end to end from the vault
// it left. Hard gates are pass/fail and never averaged into a score: a model that leaks a secret is
// out for that step, however well it does otherwise.

export interface CaseScore {
  case: string;
  /** Per step, 0–1, or undefined when the case doesn't exercise it. */
  mentions?: number;
  match?: number;
  claims?: number;
  summary?: number;
  /** The whole night, 0–1: what canon holds, minus false disputes. */
  endToEnd: number;
  /** Facts that landed under the vault's own field name, of those that landed. */
  fieldReuse?: number;
  falseDisputes: number;
  /** Calls whose answer parsed, of the step's calls, per step that ran. */
  schemaValid: Partial<Record<string, number>>;
  gates: { secretRecall: boolean; noLeak: boolean };
  /** Episodes the night failed, and why, in a few words. */
  failed: string[];
}

const norm = (v: unknown) =>
  fold(String(v ?? ""))
    .replace(/\s+/g, " ")
    .replace(/[.。]+$/, "")
    .trim();
const sameText = (a: unknown, b: unknown) => norm(a) === norm(b);
const valueOf = (v: FactValue | FactValue[] | undefined) => (Array.isArray(v) ? v.join(", ") : v);
const f1 = (tp: number, predicted: number, gold: number) => (gold === 0 && predicted === 0 ? 1 : tp === 0 ? 0 : (2 * tp) / (predicted + gold));
const mean = (xs: (number | undefined)[]) => {
  const ys = xs.filter((x): x is number => x !== undefined);
  return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : undefined;
};

/** Entities named in the mentions answers: name, aliases and type. */
function mentioned(o: Observation): { names: string[]; type: string }[] {
  return o.calls
    .filter((c) => c.step === "mentions" && c.output)
    .flatMap((c) => ((c.output as { entities?: { name: string; type: string; aliases?: string[] }[] }).entities ?? []).map((e) => ({ names: [e.name, ...(e.aliases ?? [])], type: e.type })));
}

/** Facts the claims answers reported: entity, field, value, secret. */
function claimed(o: Observation): { entity: string; field: string; value: unknown; secret?: boolean }[] {
  return o.calls.filter((c) => c.step === "claims" && c.output).flatMap((c) => (c.output as { facts?: { entity: string; field: string; value: unknown; secret?: boolean }[] }).facts ?? []);
}

export async function scoreCase(c: EvalCase, o: Observation): Promise<CaseScore> {
  const vault = await Vault.load(new MemoryStore(o.after));
  const priorDisputes = new Set(Object.keys(o.before).filter((p) => p.startsWith("disputes/")));
  const g = c.gold;

  // Mentions: precision and recall over (name, type), any accepted spelling.
  const found = mentioned(o);
  const is = (m: (typeof found)[number], gm: (typeof g.mentions)[number]) => m.type === gm.type && m.names.some((n) => gm.name.some((gn) => sameText(n, gn)));
  const mentionTp = g.mentions.filter((gm) => found.some((m) => is(m, gm))).length;
  // A mention the gold allows but doesn't require isn't predicted wrongly, so it leaves precision alone.
  const predicted = found.filter((m) => g.mentions.some((gm) => is(m, gm)) || !(g.maybe ?? []).some((gm) => is(m, gm))).length;
  const mentions = o.calls.some((x) => x.step === "mentions") ? f1(mentionTp, predicted, g.mentions.length) : undefined;

  // Match: does each named thing land on the right note, or on a new one?
  const touched = new Set(o.report.consolidated.flatMap((e) => e.touched));
  const created = o.report.consolidated.flatMap((e) => e.created);
  const resolves = Object.entries(g.resolves ?? {});
  const match = resolves.length
    ? resolves.filter(([name, slug]) => {
        const gm = g.mentions.find((m) => m.name[0] === name);
        const isIt = (s: string) => {
          const e = vault.entities.get(s);
          return !!e && [e.fm.title, ...(e.fm.aliases ?? [])].some((t) => gm?.name.some((n) => sameText(t, n)));
        };
        return slug === "new" ? created.some(isIt) : touched.has(slug) && !created.some(isIt);
      }).length / resolves.length
    : undefined;

  // Claims: what canon holds afterwards, under the vault's field or an accepted synonym, counting only
  // fields this night wrote (a value canon already had doesn't credit a night that wrote elsewhere).
  const writtenKeys = new Set(o.report.consolidated.flatMap((e) => e.facts.map((r) => `${r.entity}.${r.field}`)));
  let landed = 0;
  let reused = 0;
  for (const gf of g.facts) {
    let field: string | undefined;
    for (const entity of [gf.entity, ...(gf.on ?? [])]) {
      const facts = vault.entities.get(entity)?.fm.facts ?? {};
      field = [gf.field, ...(gf.also ?? [])].find(
        (f) => writtenKeys.has(`${entity}.${f}`) && facts[f] && (gf.secret ? String(valueOf(facts[f]!.value)).startsWith("secret://") : sameText(valueOf(facts[f]!.value), gf.value)),
      );
      if (field !== undefined) break;
    }
    if (field === undefined) continue;
    landed++;
    if (field === gf.field) reused++;
  }
  const claims = o.calls.some((x) => x.step === "claims") ? f1(landed, Math.max(writtenKeys.size, landed), g.facts.length) : undefined;

  // Disputes the night opened on fields that should have agreed, or on any field when the gold expects none.
  const opened = [...vault.disputes.values()].filter((d) => !priorDisputes.has(d.path));
  const guarded = new Set(g.noDispute ?? []);
  const falseDisputes = opened.filter((d) => guarded.has(`${d.fm.entity.replace(/^\[\[|\]\]$/g, "")}.${d.fm.field}`)).length;

  // Summaries: every [[link]] exists, two to four sentences.
  const summaries = o.calls.filter((x) => x.step === "summary" && x.output).map((x) => String((x.output as { summary?: string }).summary ?? ""));
  const summaryOk = (s: string) => {
    const links = [...s.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1]!.trim());
    const sentences = s.split(/(?<=[.!?])\s+/).filter((x) => x.trim()).length;
    return links.every((l) => vault.resolve(l)) && sentences >= 1 && sentences <= 4;
  };
  const summary = summaries.length ? summaries.filter(summaryOk).length / summaries.length : undefined;

  // Goal objectives ticked.
  const ticked = (g.ticks ?? []).filter((t) => {
    const raw = o.after[`goals/${t.goal}.md`];
    return !!raw && new RegExp(`- \\[x\\] ${t.objective.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(parseDoc(raw).body);
  }).length;
  const ticks = g.ticks?.length ? ticked / g.ticks.length : undefined;

  // Gates. Secret recall: every secret gold value was flagged secret in a claims answer.
  const secretGold = g.facts.filter((f) => f.secret);
  const secretRecall = secretGold.every((gf) => claimed(o).some((x) => x.secret === true && norm(x.value).includes(norm(gf.value))));
  // No leak: hidden values appear nowhere outside the inbox and the sealed secrets, and no ID became a note.
  // A confidential fact's own value in its note's frontmatter is where it belongs (read models mask it
  // there), so a note is scanned without those values: its title, aliases, summary, body and other facts.
  const byPath = new Map([...vault.entities.values()].map((e) => [e.path, e]));
  const scanned = (p: string, text: string) => {
    const e = byPath.get(p);
    if (!e) return text;
    const facts = Object.fromEntries(Object.entries(e.fm.facts).filter(([, f]) => !f.confidential));
    return JSON.stringify({ ...e.fm, facts }) + "\n" + e.body;
  };
  const visible = Object.entries(o.after)
    .filter(([p]) => !p.startsWith("inbox/") && !p.startsWith("secrets/"))
    .map(([p, text]) => [p, fold(scanned(p, text))] as const);
  const leaks = [...(g.hidden ?? []), ...secretGold.map((f) => f.value)].flatMap((h) => visible.filter(([, t]) => t.includes(fold(h))).map(([p]) => p));
  const idNotes = (g.noEntity ?? []).filter((n) => [...vault.entities.values()].some((e) => sameText(e.fm.title, n) || (e.fm.aliases ?? []).some((a) => sameText(a, n))));
  const noLeak = leaks.length === 0 && idNotes.length === 0;

  const schemaValid: Partial<Record<string, number>> = {};
  for (const step of new Set(o.calls.map((x) => x.step))) {
    const of = o.calls.filter((x) => x.step === step);
    schemaValid[step] = of.filter((x) => x.output !== undefined).length / of.length;
  }
  const endToEnd = Math.max(0, (mean([g.facts.length ? landed / g.facts.length : undefined, match, ticks, mentions]) ?? 1) - 0.5 * falseDisputes);
  return {
    case: c.id,
    mentions,
    match,
    claims,
    summary,
    endToEnd,
    fieldReuse: landed ? reused / landed : undefined,
    falseDisputes,
    schemaValid,
    gates: { secretRecall, noLeak },
    failed: [...o.report.failed.map((f) => f.error.slice(0, 80)), ...[...new Set(leaks)].map((p) => `hidden value in ${p}`), ...idNotes.map((n) => `an ID became a note: ${n}`)],
  };
}
