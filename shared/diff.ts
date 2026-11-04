export type DiffLineKind = "add" | "del" | "ctx";
export interface DiffLine {
  kind: DiffLineKind;
  /** Line number on the base side; absent for additions. */
  old?: number;
  /** Line number on the head side; absent for deletions. */
  new?: number;
  text: string;
}
export interface Hunk {
  header: string;
  lines: DiffLine[];
}

/** Parses a GitHub file `patch` (unified diff hunks, no file headers) into numbered lines. */
export function parsePatch(patch: string | null | undefined): Hunk[] {
  if (!patch) return [];
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      current = { header: raw, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current || raw.startsWith("\\")) continue;
    const sign = raw[0];
    const text = raw.slice(1);
    if (sign === "+") current.lines.push({ kind: "add", new: newLine++, text });
    else if (sign === "-") current.lines.push({ kind: "del", old: oldLine++, text });
    else current.lines.push({ kind: "ctx", old: oldLine++, new: newLine++, text });
  }
  return hunks;
}

/** Whether a review comment (GitHub's `line` + `side`) anchors on this diff line. */
export function anchors(line: DiffLine, comment: { line: number; side: "LEFT" | "RIGHT" }): boolean {
  return comment.side === "LEFT" ? line.old === comment.line && line.kind !== "add" : line.new === comment.line && line.kind !== "del";
}
