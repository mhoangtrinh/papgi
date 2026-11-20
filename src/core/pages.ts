// Pure page-list logic: thumbnail selection and reordering.

/** Selection state for the thumbnail sidebar. */
export interface PageSelection {
  selected: number[]; // sorted page indices
  anchor: number; // last plain/ctrl-clicked page, for shift ranges
}

export function emptySelection(): PageSelection {
  return { selected: [], anchor: -1 };
}

/** Apply a click on page `index` with modifier keys. */
export function clickPage(sel: PageSelection, index: number, mods: { shift?: boolean; toggle?: boolean }): PageSelection {
  if (mods.shift && sel.anchor >= 0) {
    const [a, b] = sel.anchor < index ? [sel.anchor, index] : [index, sel.anchor];
    const range = Array.from({ length: b - a + 1 }, (_, i) => a + i);
    const base = mods.toggle ? sel.selected : [];
    return { selected: uniqSorted([...base, ...range]), anchor: sel.anchor };
  }
  if (mods.toggle) {
    const has = sel.selected.includes(index);
    return {
      selected: has ? sel.selected.filter((i) => i !== index) : uniqSorted([...sel.selected, index]),
      anchor: index,
    };
  }
  return { selected: [index], anchor: index };
}

function uniqSorted(xs: number[]): number[] {
  return [...new Set(xs)].sort((a, b) => a - b);
}

/**
 * New page order after moving the `moving` pages so they sit before position `target`
 * (target is an index into the current order, 0..count; count = append at end).
 * Returns an array where result[newIndex] = oldIndex.
 */
export function moveOrder(count: number, moving: number[], target: number): number[] {
  const set = new Set(moving);
  const order = Array.from({ length: count }, (_, i) => i);
  const kept = order.filter((i) => !set.has(i));
  const moved = order.filter((i) => set.has(i));
  // Where does `target` land once the moved pages are removed?
  let insertAt = 0;
  for (let i = 0; i < Math.min(target, count); i++) if (!set.has(i)) insertAt++;
  return [...kept.slice(0, insertAt), ...moved, ...kept.slice(insertAt)];
}

/** Where the selection ends up after `moveOrder` (indices in the new order). */
export function movedSelection(order: number[], moving: number[]): number[] {
  const set = new Set(moving);
  return order.map((old, i) => (set.has(old) ? i : -1)).filter((i) => i >= 0);
}

/** Selection after deleting pages: keep the page that now sits where the first deleted one was. */
export function afterDelete(count: number, deleted: number[]): number {
  const remaining = count - new Set(deleted).size;
  if (remaining <= 0) return -1;
  const first = Math.min(...deleted);
  return Math.min(first, remaining - 1);
}

/** Parse a page range like "1-3, 5, 8-" (1-based) into sorted 0-based indices. */
export function parseRange(text: string, count: number): number[] | null {
  const out = new Set<number>();
  const parts = text.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  for (const part of parts) {
    const m = /^(\d*)\s*(-)?\s*(\d*)$/.exec(part);
    if (!m || (!m[1] && !m[3])) return null;
    const a = m[1] ? parseInt(m[1], 10) : 1;
    const b = m[2] ? (m[3] ? parseInt(m[3], 10) : count) : a;
    if (a < 1 || b > count || a > b) return null;
    for (let i = a; i <= b; i++) out.add(i - 1);
  }
  return [...out].sort((x, y) => x - y);
}

/** Human-readable range for a list of 0-based indices, e.g. [0,1,2,4] -> "1-3, 5". */
export function formatRange(indices: number[]): string {
  const xs = uniqSorted(indices);
  const parts: string[] = [];
  let i = 0;
  while (i < xs.length) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
    parts.push(i === j ? `${xs[i] + 1}` : `${xs[i] + 1}-${xs[j] + 1}`);
    i = j + 1;
  }
  return parts.join(", ");
}

/**
 * Split groups from text like "1-3, 4, 5-" (1-based): each comma-separated part becomes one file.
 * Returns null if any part is not a valid range.
 */
export function parseGroups(text: string, count: number): number[][] | null {
  const parts = text.split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const out: number[][] = [];
  for (const part of parts) {
    const g = parseRange(part, count);
    if (!g) return null;
    out.push(g);
  }
  return out;
}

/** Groups of `n` pages: [0..n-1], [n..2n-1], ... */
export function everyN(count: number, n: number): number[][] {
  const size = Math.max(1, Math.floor(n));
  const out: number[][] = [];
  for (let i = 0; i < count; i += size) out.push([...Array(Math.min(size, count - i)).keys()].map((k) => i + k));
  return out;
}

/** File names for split parts (0-based pages): "base-p03.pdf", "base-p01-02.pdf",
 *  "base-part2.pdf" for scattered pages. Names are made unique. */
export function splitNames(base: string, groups: number[][], total: number): string[] {
  const width = String(total).length;
  const pad = (v: number) => String(v + 1).padStart(width, "0");
  const seen = new Map<string, number>();
  return groups.map((g, i) => {
    const run = g.every((v, j) => j === 0 || v === g[j - 1] + 1);
    const range = g.length === 1 ? `p${pad(g[0])}` : run ? `p${pad(g[0])}-${pad(g[g.length - 1])}` : `part${i + 1}`;
    let name = `${base}-${range}`;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    if (n > 1) name += ` (${n})`;
    return `${name}.pdf`;
  });
}
