import { describe, expect, it } from "vitest";
import { highlightLine, languageFor } from "../shared/highlight";
import { addedText, isMarkdownPath, parseMarkdown } from "../shared/markdown";
import { isViewed, patchPrint } from "../shared/review";

describe("highlightLine", () => {
  it("marks keywords, strings, numbers and line comments", () => {
    expect(highlightLine('const a = "x" + 42; // why', "js").tokens).toEqual([
      { kind: "keyword", text: "const" },
      { kind: "plain", text: " a = " },
      { kind: "string", text: '"x"' },
      { kind: "plain", text: " + " },
      { kind: "number", text: "42" },
      { kind: "plain", text: "; " },
      { kind: "comment", text: "// why" },
    ]);
  });
  it("carries a block comment across lines", () => {
    const first = highlightLine("x /* open", "js");
    expect(first.inBlock).toBe(true);
    const second = highlightLine("still */ return 1", "js", true);
    expect(second.tokens[0]).toEqual({ kind: "comment", text: "still */" });
    expect(second.tokens.find((token) => token.text === "return")?.kind).toBe("keyword");
    expect(second.inBlock).toBe(false);
  });
  it("is plain for unknown languages, case-insensitive for SQL", () => {
    expect(highlightLine("anything", null).tokens).toEqual([{ kind: "plain", text: "anything" }]);
    expect(highlightLine("SELECT 1", "sql").tokens[0]).toEqual({ kind: "keyword", text: "SELECT" });
  });
  it("picks a language from the path", () => {
    expect(languageFor("src/a.tsx")).toBe("js");
    expect(languageFor("infra/main.tf")).toBe("tf");
    expect(languageFor("Dockerfile")).toBe("sh");
    expect(languageFor("README.md")).toBeNull();
  });
});

describe("markdown documents", () => {
  it("parses tables and keeps source line numbers, HTML comments included", () => {
    const blocks = parseMarkdown(["# Title", "<!--", "hidden", "-->", "Intro", "", "| a | b |", "|---|:-:|", "| 1 | `x\\|y` |", "", "- item"].join("\n"));
    expect(blocks.map((block) => [block.kind, block.line])).toEqual([
      ["heading", 1],
      ["paragraph", 5],
      ["table", 7],
      ["list", 11],
    ]);
    const table = blocks[2] as Extract<(typeof blocks)[number], { kind: "table" }>;
    expect(table.header.map((cell) => cell[0])).toEqual([{ kind: "text", text: "a" }, { kind: "text", text: "b" }]);
    expect(table.rows[0]![1]).toEqual([{ kind: "code", text: "x|y" }]);
  });
  it("renders images as links", () => {
    expect(parseMarkdown("![shot](https://x/y.png)")[0]).toMatchObject({ inlines: [{ kind: "link", text: "🖼 shot", url: "https://x/y.png" }] });
  });
  it("rebuilds an added file's text from its patch, and only for added files", () => {
    expect(addedText("@@ -0,0 +1,2 @@\n+# Hi\n+there")).toBe("# Hi\nthere");
    expect(addedText("@@ -1,2 +1,2 @@\n a\n+b")).toBeNull();
    expect(isMarkdownPath("docs/SPEC.md")).toBe(true);
  });
});

describe("viewed marks", () => {
  it("hold only while the patch is unchanged", () => {
    const draft = { viewed: { "a.ts": patchPrint("@@ -1 +1 @@\n-a\n+b") } };
    expect(isViewed(draft, { path: "a.ts", patch: "@@ -1 +1 @@\n-a\n+b" })).toBe(true);
    expect(isViewed(draft, { path: "a.ts", patch: "@@ -1 +1 @@\n-a\n+c" })).toBe(false);
    expect(isViewed(null, { path: "a.ts" })).toBe(false);
  });
});
