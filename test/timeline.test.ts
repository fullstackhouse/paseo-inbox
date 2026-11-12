import { describe, expect, it } from "vitest";
import { draftCardFor, DraftCardSchema } from "../shared/timeline";

const call = (name: string, input: unknown, output: unknown, status = "completed") => ({ name, status, detail: { type: "mcp", input, output } });

describe("draftCardFor", () => {
  it("shows a saved draft with its headline and comments", () => {
    const card = draftCardFor(
      call(
        "mcp__inbox__inbox_review_draft",
        { verdict: "approve", confidence: 85, summary: "Fine", comments: [{ path: "a.ts", line: 3, severity: "nit", body: "Rename" }] },
        "Saved: approve · 85% · 1 nit. The human reads and posts it from the Inbox; don't post it yourself.",
      ),
    );
    expect(card).toEqual({
      tool: "draft",
      headline: "approve · 85% · 1 nit",
      verdict: "approve",
      confidence: 85,
      fields: [],
      changes: [{ op: "add", id: null, path: "a.ts", line: 3, severity: "nit", body: "Rename" }],
      refused: [],
    });
    expect(DraftCardSchema.parse(card)).toEqual(card);
  });

  it("lists what a revision applied, with the ids it assigned, and what it refused", () => {
    const card = draftCardFor(
      call(
        "mcp__inbox__inbox_review_revise",
        {
          verdict: "comment",
          summary: "New",
          edit: [{ id: "c2", body: "Better words" }, { id: "c5", severity: "minor" }],
          drop: ["c4"],
          add: [{ path: "b.ts", line: null, body: "Whole file" }],
        },
        // An MCP content array, as some providers report it.
        [{ type: "text", text: "Applied: edited c2, removed c4, added c7, set verdict, set summary. Refused: c5: the human wrote or decided on it. Ask the human to change those." }],
      ),
    );
    expect(card).toEqual({
      tool: "revise",
      headline: null,
      verdict: "comment",
      confidence: null,
      fields: ["summary"],
      changes: [
        { op: "edit", id: "c2", body: "Better words" },
        { op: "drop", id: "c4" },
        { op: "add", id: "c7", path: "b.ts", line: null, severity: null, body: "Whole file" },
      ],
      refused: ["c5: the human wrote or decided on it"],
    });
    expect(DraftCardSchema.parse(card)).toEqual(card);
  });

  it("keeps a regrade to a note distinct from an unchanged grade", () => {
    const card = draftCardFor(call("mcp__inbox__inbox_review_revise", { edit: [{ id: "c1", severity: null }] }, "Applied: edited c1."));
    expect(card?.changes).toEqual([{ op: "edit", id: "c1", severity: null }]);
  });

  it("leaves running, failed and other tool calls alone", () => {
    expect(draftCardFor(call("mcp__inbox__inbox_review_draft", {}, "", "running"))).toBeUndefined();
    expect(draftCardFor(call("mcp__inbox__inbox_review_revise", {}, "No draft yet", "failed"))).toBeUndefined();
    expect(draftCardFor(call("mcp__inbox__inbox_pr", {}, "PR"))).toBeUndefined();
    expect(draftCardFor(call("mcp__asks__ask_create", {}, "A1 [open]"))).toBeUndefined();
  });
});
