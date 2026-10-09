import { fold } from "@hippocampus/core/text";

/**
 * Score how well `query` matches `text` (higher is better, 0 = no match): whole-word and prefix
 * hits beat scattered letters. Diacritics are folded, so "belem" finds "Belém".
 */
export function fuzzyScore(query: string, text: string): number {
  const q = fold(query).trim();
  const t = fold(text);
  if (!q) return 1;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  const word = t.indexOf(` ${q}`);
  if (word >= 0) return 60;
  const at = t.indexOf(q);
  if (at >= 0) return 40 - Math.min(at, 20);
  // Letters in order, rewarding runs.
  let score = 0;
  let run = 0;
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) {
      run++;
      score += run;
      i++;
      if (i === q.length) return Math.min(30, 5 + score);
    } else run = 0;
  }
  return 0;
}

export function fuzzyFilter<T>(items: T[], query: string, keys: (item: T) => string[], limit = 50): T[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((item) => ({ item, score: Math.max(...keys(item).map((k) => fuzzyScore(query, k))) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.item);
}
