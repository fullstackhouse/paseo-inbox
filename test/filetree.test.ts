import { describe, expect, it } from "vitest";
import { fileAt, fileTree, nextUnviewed, stepFile } from "../shared/filetree";

const show = (paths: string[]) => fileTree(paths).map((row) => `${"  ".repeat(row.depth)}${row.kind === "dir" ? `${row.name}/` : row.name}`);

describe("fileTree", () => {
  it("nests files under their folders in the files' own order", () => {
    expect(show(["README.md", "src/a.ts", "src/b/c.ts", "src/d.ts"])).toEqual(["README.md", "src/", "  a.ts", "  b/", "    c.ts", "  d.ts"]);
  });

  it("merges a chain of single-folder folders into one row", () => {
    expect(show(["packages/cli/AGENTS.md", "packages/cli/src/lib/generators/index.ts", "packages/cli/src/lib/generators/__tests__/x.test.ts"])).toEqual([
      "packages/cli/",
      "  AGENTS.md",
      "  src/lib/generators/",
      "    index.ts",
      "    __tests__/",
      "      x.test.ts",
    ]);
  });

  it("keys folders by their full path so same-named folders stay distinct", () => {
    const keys = fileTree(["a/lib/x.ts", "b/lib/y.ts"]).map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("stepFile", () => {
  const paths = ["a", "b", "c"];
  it("moves and clamps at the ends", () => {
    expect(stepFile(paths, "b", 1)).toBe("c");
    expect(stepFile(paths, "c", 1)).toBe("c");
    expect(stepFile(paths, "a", -1)).toBe("a");
  });
  it("starts at an end when nothing is current", () => {
    expect(stepFile(paths, null, 1)).toBe("a");
    expect(stepFile(paths, null, -1)).toBe("c");
    expect(stepFile([], null, 1)).toBeNull();
  });
});

describe("nextUnviewed", () => {
  const paths = ["a", "b", "c", "d"];
  it("takes the next unviewed file after the current one", () => {
    expect(nextUnviewed(paths, "a", (path) => path === "b")).toBe("c");
  });
  it("wraps to an earlier unviewed file, and gives null when all are viewed", () => {
    expect(nextUnviewed(paths, "d", (path) => path !== "b")).toBe("b");
    expect(nextUnviewed(paths, "b", () => true)).toBeNull();
  });
});

describe("fileAt", () => {
  const tops = new Map([
    ["a", 0],
    ["b", 100],
    ["c", 400],
  ]);
  it("finds the card holding the position", () => {
    expect(fileAt(tops, ["a", "b", "c"], 150)).toBe("b");
    expect(fileAt(tops, ["a", "b", "c"], 400)).toBe("c");
  });
  it("falls back to the first card above the top", () => {
    expect(fileAt(tops, ["a", "b", "c"], -20)).toBe("a");
  });
});
