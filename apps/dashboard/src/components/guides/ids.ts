// Ids for static guide markup that must be unique on a page (and stable between builds).
let n = 0;

export function nextId(prefix: string): string {
  n += 1;
  return `${prefix}-${n}`;
}
