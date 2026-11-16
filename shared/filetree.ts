/** A row of the file index: a folder heading or a file under it, `depth` levels in. */
export type TreeRow = { kind: "dir"; key: string; name: string; depth: number } | { kind: "file"; key: string; path: string; name: string; depth: number };

type Node = { name: string; dirs: Map<string, Node>; files: string[]; order: (string | { dir: string })[] };

const node = (name: string): Node => ({ name, dirs: new Map(), files: [], order: [] });

/**
 * The PR's files as a folder tree, in the order the files came (GitHub's, path-sorted), so the tree
 * reads top to bottom in the same order as the diffs and `j`/`k`. A folder holding only one folder
 * merges with it ("packages/cli/src"), like GitHub's file tree.
 */
export function fileTree(paths: readonly string[]): TreeRow[] {
  const root = node("");
  for (const path of paths) {
    const parts = path.split("/");
    let at = root;
    for (const part of parts.slice(0, -1)) {
      let next = at.dirs.get(part);
      if (!next) {
        next = node(part);
        at.dirs.set(part, next);
        at.order.push({ dir: part });
      }
      at = next;
    }
    at.files.push(path);
    at.order.push(path);
  }
  const rows: TreeRow[] = [];
  const walk = (at: Node, depth: number, prefix: string) => {
    for (const entry of at.order) {
      if (typeof entry === "string") {
        rows.push({ kind: "file", key: entry, path: entry, name: entry.slice(entry.lastIndexOf("/") + 1), depth });
        continue;
      }
      let dir = at.dirs.get(entry.dir)!;
      let name = dir.name;
      while (dir.files.length === 0 && dir.dirs.size === 1) {
        dir = [...dir.dirs.values()][0]!;
        name = `${name}/${dir.name}`;
      }
      const key = `${prefix}${name}/`;
      rows.push({ kind: "dir", key, name, depth });
      walk(dir, depth + 1, key);
    }
  };
  walk(root, 0, "");
  return rows;
}

/** The file `offset` steps from `current` in `paths` (clamped to the ends); the first file when `current` isn't in it. */
export function stepFile(paths: readonly string[], current: string | null, offset: number): string | null {
  if (!paths.length) return null;
  const index = current === null ? -1 : paths.indexOf(current);
  if (index < 0) return paths[offset < 0 ? paths.length - 1 : 0]!;
  return paths[Math.min(paths.length - 1, Math.max(0, index + offset))]!;
}

/** The first file after `current` that isn't viewed, else the first unviewed one before it, else null. */
export function nextUnviewed(paths: readonly string[], current: string, viewed: (path: string) => boolean): string | null {
  const index = paths.indexOf(current);
  const after = paths.slice(index + 1).find((path) => path !== current && !viewed(path));
  return after ?? paths.slice(0, Math.max(0, index)).find((path) => !viewed(path)) ?? null;
}

/** The file whose card holds `y`: the last one starting at or above it. `tops` are card tops, any order. */
export function fileAt(tops: ReadonlyMap<string, number>, order: readonly string[], y: number): string | null {
  let found: string | null = null;
  let best = -Infinity;
  for (const path of order) {
    const top = tops.get(path);
    if (top === undefined || top > y || top < best) continue;
    best = top;
    found = path;
  }
  return found ?? order.find((path) => tops.has(path)) ?? null;
}
