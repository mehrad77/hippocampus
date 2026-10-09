import type { SearchHit } from "@hippocampus/core";

/** Reciprocal rank fusion: rewards documents ranked well by several retrievers, ignoring their score scales. */
export function rrf(lists: SearchHit[][], k = 60): SearchHit[] {
  const fused = new Map<string, SearchHit>();
  for (const list of lists) {
    list.forEach((hit, rank) => {
      const prev = fused.get(hit.id);
      fused.set(hit.id, { ...hit, score: (prev?.score ?? 0) + 1 / (k + rank + 1) });
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score);
}

/**
 * One hop of graph expansion: a candidate related to one of the top hits gains a share of that
 * hit's score, but never overtakes it. Only re-ranks; it never adds documents (recall lists
 * relations separately).
 */
export function boostNeighbors(ranked: SearchHit[], related: (id: string) => Set<string>, opts: { top?: number; factor?: number } = {}): SearchHit[] {
  const top = ranked.slice(0, opts.top ?? 3).filter((h) => h.kind === "entity");
  const factor = opts.factor ?? 0.2;
  return ranked
    .map((hit) => {
      const parents = top.filter((t) => t.id !== hit.id && t.score > hit.score && related(t.id).has(hit.id));
      if (!parents.length) return hit;
      const bonus = parents.reduce((sum, t) => sum + t.score * factor, 0);
      const ceiling = Math.max(...parents.map((t) => t.score)) * (1 - 1e-6);
      return { ...hit, score: Math.min(hit.score + bonus, ceiling) };
    })
    .sort((a, b) => b.score - a.score);
}

export function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  return norm ? v.map((x) => x / norm) : v;
}

/** Cosine similarity of unit vectors. */
export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length && i < b.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

export const toBlob = (v: Float32Array): Uint8Array => new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));

/** BLOBs come back as Uint8Array (node:sqlite), ArrayBuffer, or an array of bytes (D1). */
export function fromBlob(blob: unknown): Float32Array {
  const bytes = blob instanceof Uint8Array ? blob : blob instanceof ArrayBuffer ? new Uint8Array(blob) : new Uint8Array(blob as number[]);
  return new Float32Array(bytes.slice().buffer);
}
