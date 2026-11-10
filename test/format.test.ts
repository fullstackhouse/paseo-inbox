import { describe, expect, it } from "vitest";
import { anchors, parsePatch } from "../shared/diff";

describe("parsePatch", () => {
  const patch = [
    "@@ -10,4 +10,5 @@ function a() {",
    " keep",
    "-old",
    "+new",
    "+added",
    " tail",
    "\\ No newline at end of file",
  ].join("\n");
  it("numbers both sides", () => {
    const [hunk] = parsePatch(patch);
    expect(hunk!.header).toBe("@@ -10,4 +10,5 @@ function a() {");
    expect(hunk!.lines).toEqual([
      { kind: "ctx", old: 10, new: 10, text: "keep" },
      { kind: "del", old: 11, text: "old" },
      { kind: "add", new: 11, text: "new" },
      { kind: "add", new: 12, text: "added" },
      { kind: "ctx", old: 12, new: 13, text: "tail" },
    ]);
  });
  it("handles a missing patch (binary or too large)", () =>
    expect(parsePatch(undefined)).toEqual([]));
  it("anchors RIGHT comments on new lines and LEFT on old ones", () => {
    const lines = parsePatch(patch)[0]!.lines;
    expect(
      lines.filter((line) => anchors(line, { line: 11, side: "RIGHT" })).map((line) => line.text),
    ).toEqual(["new"]);
    expect(
      lines.filter((line) => anchors(line, { line: 11, side: "LEFT" })).map((line) => line.text),
    ).toEqual(["old"]);
  });
});
