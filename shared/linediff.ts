// A line diff (Myers) rendered as GitHub's `patch`: unified hunks, no file headers. Used when GitHub's
// compare drops files (it lists at most 300), so their patches are rebuilt from the two blobs.

type Op = { kind: "ctx" | "del" | "add"; text: string };

const linesOf = (text: string) => {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

/** The edit script from `a` to `b`, or null when it has more than `maxEdits` edits (too costly to find). */
function edits(a: string[], b: string[], maxEdits: number): Op[] | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--;
  const head = a.slice(0, start).map((text): Op => ({ kind: "ctx", text }));
  const tail = a.slice(endA).map((text): Op => ({ kind: "ctx", text }));
  const x0 = a.slice(start, endA);
  const y0 = b.slice(start, endB);
  const n = x0.length;
  const m = y0.length;
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // Each step's frontier, kept only for the diagonals it can reach: O(D²) memory.
  const trace: Int32Array[] = [];
  let found = n + m === 0 ? 0 : -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && x0[x] === y0[y]) x++, y++;
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;
  const middle: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const snap = trace[d] ?? new Int32Array(3);
    const at = (k: number) => snap[k + d + 1] ?? 0;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) middle.push({ kind: "ctx", text: x0[--x]! }), y--;
    if (d === 0) break;
    if (x === prevX) middle.push({ kind: "add", text: y0[--y]! });
    else middle.push({ kind: "del", text: x0[--x]! });
  }
  return [...head, ...middle.reverse(), ...tail];
}

/**
 * GitHub-style `patch` text from `before` to `after` with `context` lines around each change, plus the
 * counts; null when the two texts are too far apart to diff cheaply.
 */
export function unifiedPatch(before: string, after: string, context = 3, maxEdits = 2000): { patch: string; additions: number; deletions: number } | null {
  const ops = edits(linesOf(before), linesOf(after), maxEdits);
  if (!ops) return null;
  const changed = ops.flatMap((op, index) => (op.kind === "ctx" ? [] : [index]));
  const hunks: string[] = [];
  let i = 0;
  while (i < changed.length) {
    let last = changed[i]!;
    let j = i;
    // Changes closer than two contexts apart share a hunk.
    while (j + 1 < changed.length && changed[j + 1]! - last <= 2 * context) last = changed[++j]!;
    const from = Math.max(0, changed[i]! - context);
    const to = Math.min(ops.length - 1, last + context);
    let oldLine = 1;
    let newLine = 1;
    for (const op of ops.slice(0, from)) {
      if (op.kind !== "add") oldLine++;
      if (op.kind !== "del") newLine++;
    }
    const slice = ops.slice(from, to + 1);
    const oldLen = slice.filter((op) => op.kind !== "add").length;
    const newLen = slice.filter((op) => op.kind !== "del").length;
    // Git names the line before an empty side (0 at the start of the file).
    const header = `@@ -${oldLen ? oldLine : oldLine - 1},${oldLen} +${newLen ? newLine : newLine - 1},${newLen} @@`;
    hunks.push([header, ...slice.map((op) => `${op.kind === "add" ? "+" : op.kind === "del" ? "-" : " "}${op.text}`)].join("\n"));
    i = j + 1;
  }
  return { patch: hunks.join("\n"), additions: ops.filter((op) => op.kind === "add").length, deletions: ops.filter((op) => op.kind === "del").length };
}
