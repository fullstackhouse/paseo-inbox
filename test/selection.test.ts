import { describe, expect, it } from "vitest";
import { askMessage, QUOTE_MAX, quoteFor } from "../shared/selection";

describe("quoteFor", () => {
  it("drops blank edge lines and trailing spaces, keeps indentation", () => {
    expect(quoteFor("\n  \n  const a = 1;   \n    return a;\n\n")).toBe("  const a = 1;\n    return a;");
  });

  it("is null for a whitespace-only selection", () => {
    expect(quoteFor(" \n\t\n")).toBeNull();
  });

  it("cuts a long selection in the middle", () => {
    const quote = quoteFor(`start${"x".repeat(QUOTE_MAX * 2)}end`)!;
    expect(quote.length).toBeLessThanOrEqual(QUOTE_MAX);
    expect(quote.startsWith("start")).toBe(true);
    expect(quote.endsWith("end")).toBe(true);
    expect(quote).toContain("\n…\n");
  });
});

describe("askMessage", () => {
  it("puts the quote between the subject and the question", () => {
    expect(askMessage("the diff of src/a.ts", "Why not reuse b()?", "const a = 1;\n\nreturn a;")).toBe(
      "About the diff of src/a.ts:\n\n> const a = 1;\n>\n> return a;\n\nWhy not reuse b()?",
    );
  });

  it("keeps the old shape without a quote", () => {
    expect(askMessage("your summary and verdict", "Why approve?")).toBe("About your summary and verdict:\n\nWhy approve?");
  });
});
