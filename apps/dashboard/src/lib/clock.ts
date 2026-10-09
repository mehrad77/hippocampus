/** SVG pie-wedge paths for a clock of `segments` around (c, c) with radius r, starting at 12 o'clock. */
export function clockSegments(segments: number, r: number, c: number): string[] {
  const n = Math.max(1, Math.floor(segments));
  if (n === 1) return [`M ${c} ${c - r} A ${r} ${r} 0 1 1 ${c - 0.01} ${c - r} Z`];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * 2 * Math.PI - Math.PI / 2;
    const a1 = ((i + 1) / n) * 2 * Math.PI - Math.PI / 2;
    const p = (a: number) => `${round(c + r * Math.cos(a))} ${round(c + r * Math.sin(a))}`;
    out.push(`M ${c} ${c} L ${p(a0)} A ${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p(a1)} Z`);
  }
  return out;
}

const round = (x: number) => Math.round(x * 100) / 100;
