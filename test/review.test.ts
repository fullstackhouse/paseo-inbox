import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { postPullReview } from "../server/github";
import { Inbox } from "../server/inbox";
import { postDraft } from "../server/post";
import { ReviewStore } from "../server/reviews";
import { callTool } from "../server/tools";
import { emptyState, type State } from "../shared/inbox";
import {
  addHumanComment,
  composeReview,
  postSummary,
  deleteHumanComment,
  draftHeadline,
  placement,
  replaceDraft,
  ReviewInputSchema,
  reviseDraft,
  ReviseInputSchema,
  toDraft,
  updateComment,
  verdictMismatch,
  walkthrough,
  withGrade,
  type PrDetails,
} from "../shared/review";
import { config, NOW, pr } from "./fixtures";

const PATH = "src/basket/BasketPage.tsx";
// Lines 10-14 of the new file are in the diff.
const files = [
  { path: PATH, patch: "@@ -10,3 +10,5 @@\n a\n+b\n+c\n d\n+e" },
  { path: "README.md", patch: "@@ -1 +1 @@\n-x\n+y" },
  { path: "logo.png" },
];
const input = ReviewInputSchema.parse({
  verdict: "request-changes",
  confidence: 80,
  reasoning: "One blocker.",
  summary: "The basket loses items on refresh.",
  chapters: [{ title: "Basket state", body: "Where it breaks.", files: [PATH, PATH, "gone.ts"] }],
  comments: [
    { path: PATH, line: 11, severity: "blocker", body: "State is never persisted." },
    { path: PATH, line: 99, severity: "minor", body: "Off the diff." },
    { path: PATH, line: null, body: "Is this file still needed?" },
    { path: PATH, line: 12, severity: "major", body: "Old grade." },
  ],
});
const run = { id: "acme/shop#7|draft-review|aaaaaaa111", itemKey: "acme/shop#7", version: "aaaaaaa111" };
const draft = toDraft(input, run, NOW);

describe("schema", () => {
  it("defaults to ungraded, file-level allowed, old 'major' reads as minor", () => {
    expect(draft.comments.map((comment) => [comment.id, comment.severity, comment.line, comment.author])).toEqual([
      ["c1", "blocker", 11, "ai"],
      ["c2", "minor", 99, "ai"],
      ["c3", null, null, "ai"],
      ["c4", "minor", 12, "ai"],
    ]);
  });
});

describe("placement and composeReview", () => {
  it("puts diff-line comments inline and folds file-level and off-diff ones into the body", () => {
    expect(draft.comments.map((comment) => placement(comment, files))).toEqual(["inline", "outside", "file", "inline"]);
    const { payload, inline, folded } = composeReview(draft, files);
    expect([inline, folded]).toEqual([2, 2]);
    expect(payload.event).toBe("REQUEST_CHANGES");
    expect(payload.commit_id).toBe("aaaaaaa111");
    expect(payload.comments).toEqual([
      { path: PATH, line: 11, side: "RIGHT", body: "🚨 **blocker** — State is never persisted." },
      { path: PATH, line: 12, side: "RIGHT", body: "⚠️ **minor** — Old grade." },
    ]);
    expect(payload.body).toContain("The basket loses items on refresh.");
    expect(payload.body).toContain("1. **Basket state** — `src/basket/BasketPage.tsx`");
    expect(payload.body).toContain(`### Additional notes\n\n- \`${PATH}:99\` — ⚠️ **minor** — Off the diff.\n- \`${PATH}\` — Is this file still needed?`);
    expect(payload.body).toContain("sent by a human");
  });
  it("skips dropped comments and honours the human's verdict", () => {
    const edited = { ...updateComment(draft, "c1", { status: "dropped" }), verdictOverride: "approve" as const };
    const { payload } = composeReview(edited, files);
    expect(payload.event).toBe("APPROVE");
    expect(payload.comments.map((comment) => comment.line)).toEqual([12]);
  });
  it("leaves ungraded remarks bare", () => expect(withGrade("Why?", null)).toBe("Why?"));
});

describe("postSummary", () => {
  // Two raised comments: one held back, one the human replies with. Neither goes in the review.
  const raised = { ...draft, comments: [...draft.comments, { ...draft.comments[0]!, id: "r1", raised: 5, reply: false }, { ...draft.comments[0]!, id: "r2", raised: 6, reply: true }] };
  it("counts what composeReview posts, with the folded count once the files are known", () => {
    expect(postSummary(raised, files)).toEqual({ posted: 4, folded: 2, replies: 1, held: 1, dropped: 0 });
    expect(postSummary(raised, null)).toEqual({ posted: 4, folded: null, replies: 1, held: 1, dropped: 0 });
    expect(postSummary(updateComment(raised, "c1", { status: "dropped" }), files)).toMatchObject({ posted: 3, folded: 2, dropped: 1 });
  });
});

describe("walkthrough", () => {
  it("dedupes files, drops unchanged ones, and collects the rest under Other changes", () => {
    expect(walkthrough(draft, files)).toEqual([
      { title: "Basket state", body: "Where it breaks.", files: [PATH] },
      { title: "Other changes", body: "", files: ["README.md", "logo.png"], other: true },
    ]);
  });
});

describe("human edits", () => {
  it("adds and deletes your own comments only", () => {
    const mine = addHumanComment(draft, { path: PATH, line: 13, body: "Mine." });
    expect(mine.comments.at(-1)).toMatchObject({ id: "h1", author: "human", status: "kept", severity: null });
    expect(deleteHumanComment(mine, "h1").comments).toHaveLength(4);
    expect(() => deleteHumanComment(mine, "c1")).toThrow("Only your own comments");
  });
  it("regrades, edits and refuses a posted draft", () => {
    expect(updateComment(draft, "c2", { severity: "nit" }).comments[1]).toMatchObject({ severity: "nit", status: "edited" });
    expect(updateComment(draft, "c3", { body: " better " }).comments[2]).toMatchObject({ body: "better", status: "edited" });
    expect(() => updateComment({ ...draft, postedUrl: "u" }, "c1", { status: "kept" })).toThrow("Already posted");
  });
  it("flags a verdict that disagrees with the findings", () => {
    expect(verdictMismatch(draft)).toBeNull();
    expect(verdictMismatch({ ...draft, verdictOverride: "approve" })).toBe("Approving over 1 blocker");
    expect(verdictMismatch(updateComment(draft, "c1", { status: "dropped" }))).toBe("Requesting changes with no blocker left");
  });
  it("headline counts by grade", () => expect(draftHeadline(draft)).toBe("request-changes · 80% · 1 blocker, 2 minor, 1 note"));
});

describe("reviewer revisions", () => {
  const touched = addHumanComment(updateComment(draft, "c2", { status: "kept" }), { path: PATH, line: 13, body: "Mine." });

  it("re-saving keeps everything the human wrote or decided on", () => {
    const again = replaceDraft(touched, ReviewInputSchema.parse({ verdict: "approve", confidence: 90, summary: "New.", comments: [{ path: PATH, line: 14, body: "Fresh." }] }), run, NOW);
    expect(again.comments.map((comment) => [comment.id, comment.body])).toEqual([
      ["c2", "Off the diff."],
      ["h1", "Mine."],
      ["c5", "Fresh."],
    ]);
    expect(again.summary).toBe("New.");
  });
  it("re-saving a posted draft is refused", () => {
    expect(() => replaceDraft({ ...draft, postedUrl: "https://x/1" }, input, run, NOW)).toThrow("already posted");
  });
  it("revise applies edits, refuses the human's comments, adds with fresh ids", () => {
    const { draft: revised, applied, refused } = reviseDraft(
      touched,
      ReviseInputSchema.parse({ verdict: "approve", edit: [{ id: "c1", severity: "minor" }, { id: "c2", body: "x" }], drop: ["h1", "c4"], add: [{ path: PATH, line: 10, body: "New." }] }),
    );
    expect(applied).toEqual(["edited c1", "removed c4", "added c5", "set verdict"]);
    expect(refused).toEqual(["c2: the human wrote or decided on it", "h1: the human wrote or decided on it"]);
    expect(revised.comments.map((comment) => comment.id)).toEqual(["c1", "c2", "c3", "h1", "c5"]);
    expect(revised.comments[0]!.severity).toBe("minor");
    expect(revised.verdict).toBe("approve");
  });
});

/** An inbox with one running review run, agent `agent-1`, at PR head `aaaaaaa111`. */
function setup() {
  let state: State = emptyState();
  const inbox = new Inbox({
    loadConfig: () => config(),
    search: async (query) => (query.includes("review-requested") ? [pr()] : []),
    start: async () => ({ agentId: "agent-1", workspaceId: "ws" }),
    load: () => state,
    save: (next) => (state = next),
    now: () => NOW,
  });
  const reviews = new ReviewStore(mkdtempSync(join(tmpdir(), "inbox-reviews-")));
  return { inbox, reviews, state: () => state };
}
const raw = { verdict: "request-changes", confidence: 80, summary: "s", comments: [{ path: PATH, line: 11, severity: "blocker", body: "b" }, { path: PATH, line: 99, body: "off" }] };
const details = (headSha: string): PrDetails => ({ body: "", author: "ola", baseRef: "main", headRef: "x", headSha, additions: 1, deletions: 0, changedFiles: 1, createdAt: NOW, files: files.map((file) => ({ status: "modified", additions: 1, deletions: 0, ...file })), threads: [], title: "t", requestedReviewers: [] });

describe("MCP tools", () => {
  it("draft saves for the calling run; revise reports refusals; others are refused", async () => {
    const { inbox, reviews, state } = setup();
    await inbox.poll();
    expect((await callTool(inbox, reviews, "agent-1", "inbox_review_draft", raw, NOW)).isError).toBeFalsy();
    const runId = state().runs[0]!.id;
    expect(state().runs[0]).toMatchObject({ state: "needs-decision", reason: "review drafted: request-changes · 80% · 1 blocker, 1 note" });
    reviews.save(updateComment(reviews.get(runId)!, "c1", { status: "kept" }));
    expect((await callTool(inbox, reviews, "agent-1", "inbox_review_revise", { drop: ["c1"] })).text).toBe("Nothing changed. Refused: c1: the human wrote or decided on it. Ask the human to change those.");
    expect((await callTool(inbox, reviews, "agent-1", "inbox_review_revise", { drop: ["c2"] })).text).toBe("Applied: removed c2.");
    expect((await callTool(inbox, reviews, "someone-else", "inbox_review_draft", raw)).text).toBe("Only agents started by paseo-inbox can use the inbox tools");
  });
});

describe("postDraft", () => {
  it("checks GitHub's live head, folds what can't go inline, posts once", async () => {
    const { inbox, reviews, state } = setup();
    await inbox.poll();
    await callTool(inbox, reviews, "agent-1", "inbox_review_draft", raw, NOW);
    const runId = state().runs[0]!.id;
    const post = vi.fn(async () => "https://github.com/acme/shop/pull/7#pullrequestreview-1");
    await expect(postDraft(inbox, reviews, runId, post, async () => details("bbbbbbb222"))).rejects.toThrow("new commits since this draft (aaaaaaa → bbbbbbb)");
    expect(post).not.toHaveBeenCalled();
    expect(await postDraft(inbox, reviews, runId, post, async () => details("aaaaaaa111"), NOW)).toEqual({ url: "https://github.com/acme/shop/pull/7#pullrequestreview-1", inline: 1, folded: 1, replies: 0, failedReplies: 0 });
    expect(reviews.get(runId)).toMatchObject({ postedVerdict: "request-changes" });
    expect(state().runs[0]).toMatchObject({ state: "done" });
    await expect(postDraft(inbox, reviews, runId, post, async () => details("aaaaaaa111"))).rejects.toThrow("Already posted");
    // A posted draft can't be replaced by the agent either.
    expect((await callTool(inbox, reviews, "agent-1", "inbox_review_draft", raw)).isError).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe("postPullReview", () => {
  it("POSTs the payload on stdin and returns the review URL", async () => {
    const runGh = vi.fn(async () => JSON.stringify({ id: 1, html_url: "https://github.com/acme/shop/pull/7#pullrequestreview-1" }));
    expect(await postPullReview("acme/shop", 7, { event: "APPROVE" }, runGh)).toBe("https://github.com/acme/shop/pull/7#pullrequestreview-1");
    expect(runGh).toHaveBeenCalledWith(["api", "--method", "POST", "repos/acme/shop/pulls/7/reviews", "--input", "-"], '{"event":"APPROVE"}');
  });
});
