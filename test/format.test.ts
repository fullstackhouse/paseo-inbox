import { describe, expect, it } from "vitest";
import { anchors, parsePatch } from "../shared/diff";
import { parseInline, parseMarkdown } from "../shared/markdown";

describe("parsePatch", () => {
  const patch = ["@@ -10,4 +10,5 @@ function a() {", " keep", "-old", "+new", "+added", " tail", "\\ No newline at end of file"].join("\n");
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
  it("handles a missing patch (binary or too large)", () => expect(parsePatch(undefined)).toEqual([]));
  it("anchors RIGHT comments on new lines and LEFT on old ones", () => {
    const lines = parsePatch(patch)[0]!.lines;
    expect(lines.filter((line) => anchors(line, { line: 11, side: "RIGHT" })).map((line) => line.text)).toEqual(["new"]);
    expect(lines.filter((line) => anchors(line, { line: 11, side: "LEFT" })).map((line) => line.text)).toEqual(["old"]);
  });
});

describe("markdown", () => {
  it("parses inline code, bold, italic and links", () => {
    expect(parseInline("Run `npm test`, **then** read [the spec](https://x.y/s) _now_.")).toEqual([
      { kind: "text", text: "Run " },
      { kind: "code", text: "npm test" },
      { kind: "text", text: ", " },
      { kind: "bold", inlines: [{ kind: "text", text: "then" }] },
      { kind: "text", text: " read " },
      { kind: "link", text: "the spec", url: "https://x.y/s" },
      { kind: "text", text: " " },
      { kind: "italic", text: "now" },
      { kind: "text", text: "." },
    ]);
  });
  it("parses code inside bold", () => {
    expect(parseInline("**the last commit (`acb01c3`) changed it** ok")).toEqual([
      { kind: "bold", inlines: [{ kind: "text", text: "the last commit (" }, { kind: "code", text: "acb01c3" }, { kind: "text", text: ") changed it" }] },
      { kind: "text", text: " ok" },
    ]);
  });
  it("leaves snake_case alone", () => expect(parseInline("call review_post_now")).toEqual([{ kind: "text", text: "call review_post_now" }]));
  it("parses headings, lists, code, quotes and paragraphs; drops HTML comments", () => {
    const blocks = parseMarkdown(["## Problem", "<!-- hidden -->", "The basket", "loses items.", "", "- one", "- [x] two", "  wrapped", "1. first", "```ts", "const a = 1;", "```", "> quoted", "---"].join("\n"));
    expect(blocks.map((block) => block.kind)).toEqual(["heading", "paragraph", "list", "list", "code", "quote", "rule"]);
    expect(blocks[1]).toEqual({ kind: "paragraph", inlines: [{ kind: "text", text: "The basket loses items." }], line: 3 });
    expect(blocks[2]).toMatchObject({ ordered: false, items: [[{ text: "one" }], [{ text: "☑ two" }, { text: " " }, { text: "wrapped" }]] });
    expect(blocks[4]).toEqual({ kind: "code", text: "const a = 1;", line: 10 });
  });
});
