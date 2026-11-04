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
import { draftHeadline, reviewPayload, toDraft, updateComment } from "../shared/review";
import { config, NOW, pr } from "./fixtures";

const input = {
  verdict: "request-changes",
  confidence: 80,
  summary: "The basket loses items on refresh.",
  comments: [
    { path: "src/basket/BasketPage.tsx", line: 12, severity: "blocker", body: "State is never persisted." },
    { path: "src/basket/BasketPage.tsx", line: 30, body: "Typo in the label." },
  ],
};

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

describe("review payload", () => {
  const draft = toDraft({ ...input, verdict: "request-changes", chapters: [], comments: input.comments.map((c) => ({ side: "RIGHT" as const, severity: "minor" as const, ...c })) } as never, { id: "r", itemKey: "acme/shop#7", version: "aaaaaaa111" }, NOW);

  it("maps the verdict and keeps every comment that isn't dropped", () => {
    const dropped = { ...draft, comments: draft.comments.map((c) => (c.id === "c2" ? { ...c, status: "dropped" as const } : c)) };
    expect(reviewPayload(dropped)).toEqual({
      commit_id: "aaaaaaa111",
      event: "REQUEST_CHANGES",
      body: "The basket loses items on refresh.",
      comments: [{ path: "src/basket/BasketPage.tsx", line: 12, side: "RIGHT", body: "State is never persisted." }],
    });
    expect(draftHeadline(dropped)).toBe("request-changes · 80% · 1 blocker");
  });
});

describe("inbox_review_draft tool", () => {
  it("saves the draft for the calling agent's run and hands the run to the human", async () => {
    const { inbox, reviews, state } = setup();
    await inbox.poll();
    const result = callTool(inbox, reviews, "agent-1", "inbox_review_draft", input, NOW);
    expect(result.isError).toBeFalsy();
    const run = state().runs[0]!;
    expect(run).toMatchObject({ state: "needs-decision", reason: "review drafted: request-changes · 80% · 1 blocker, 1 minor" });
    expect(reviews.get(run.id)).toMatchObject({ itemKey: "acme/shop#7", version: "aaaaaaa111", comments: [{ id: "c1", status: "draft", side: "RIGHT" }, { id: "c2" }] });
  });

  it("refuses agents the inbox didn't start, and invalid drafts", async () => {
    const { inbox, reviews } = setup();
    await inbox.poll();
    expect(callTool(inbox, reviews, "someone-else", "inbox_review_draft", input)).toMatchObject({ isError: true, text: "Only agents started by paseo-inbox can save a review draft" });
    expect(callTool(inbox, reviews, null, "inbox_review_draft", input).isError).toBe(true);
    expect(callTool(inbox, reviews, "agent-1", "inbox_review_draft", { ...input, confidence: 200 }).isError).toBe(true);
  });
});

describe("postDraft", () => {
  it("posts the draft once, then marks the run done", async () => {
    const { inbox, reviews, state } = setup();
    await inbox.poll();
    callTool(inbox, reviews, "agent-1", "inbox_review_draft", input, NOW);
    const runId = state().runs[0]!.id;
    const post = vi.fn(async () => "https://github.com/acme/shop/pull/7#pullrequestreview-1");
    expect(await postDraft(inbox, reviews, runId, post, NOW)).toEqual({ url: "https://github.com/acme/shop/pull/7#pullrequestreview-1" });
    expect(post).toHaveBeenCalledWith("acme/shop", 7, expect.objectContaining({ event: "REQUEST_CHANGES", commit_id: "aaaaaaa111" }));
    expect(state().runs[0]).toMatchObject({ state: "done", reason: "review posted: https://github.com/acme/shop/pull/7#pullrequestreview-1" });
    await expect(postDraft(inbox, reviews, runId, post)).rejects.toThrow("Already posted");
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("refuses a draft the PR has moved past, and keeps it", async () => {
    let head = "aaaaaaa111";
    let state: State = emptyState();
    const inbox = new Inbox({
      loadConfig: () => config({ rules: [{ name: "draft-review", source: "review", prompt: "x", rerun: "manual" }] }),
      search: async (query) => (query.includes("review-requested") ? [pr({ headSha: head })] : []),
      start: async () => ({ agentId: "agent-1" }),
      load: () => state,
      save: (next) => (state = next),
      now: () => NOW,
    });
    const reviews = new ReviewStore(mkdtempSync(join(tmpdir(), "inbox-reviews-")));
    await inbox.poll();
    await inbox.runNow("acme/shop#7", "draft-review");
    callTool(inbox, reviews, "agent-1", "inbox_review_draft", input, NOW);
    const runId = state.runs[0]!.id;
    head = "bbbbbbb222";
    await inbox.poll();
    const post = vi.fn();
    await expect(postDraft(inbox, reviews, runId, post)).rejects.toThrow("The PR got new commits since this draft (aaaaaaa → bbbbbbb); rerun to re-draft");
    expect(post).not.toHaveBeenCalled();
    expect(reviews.get(runId)?.postedUrl).toBeUndefined();
  });
});

describe("postPullReview", () => {
  it("POSTs the payload on stdin and returns the review URL", async () => {
    const run = vi.fn(async () => JSON.stringify({ id: 1, html_url: "https://github.com/acme/shop/pull/7#pullrequestreview-1" }));
    expect(await postPullReview("acme/shop", 7, { event: "APPROVE" }, run)).toBe("https://github.com/acme/shop/pull/7#pullrequestreview-1");
    expect(run).toHaveBeenCalledWith(["api", "--method", "POST", "repos/acme/shop/pulls/7/reviews", "--input", "-"], '{"event":"APPROVE"}');
  });
});

describe("updateComment", () => {
  const draft = toDraft({ verdict: "comment", confidence: 70, summary: "s", chapters: [], comments: [{ path: "a.ts", line: 1, side: "RIGHT", severity: "nit", body: "x" }] }, { id: "r", itemKey: "k", version: "v" }, NOW);
  it("keeps, drops and edits; an edit with no text keeps the old body", () => {
    expect(updateComment(draft, "c1", { status: "dropped" }).comments[0]!.status).toBe("dropped");
    expect(updateComment(draft, "c1", { body: " better " }).comments[0]).toMatchObject({ body: "better", status: "edited" });
    expect(updateComment(draft, "c1", { body: "  " }).comments[0]!.body).toBe("x");
  });
  it("refuses unknown comments and posted drafts", () => {
    expect(() => updateComment(draft, "c9", { status: "kept" })).toThrow("No comment c9");
    expect(() => updateComment({ ...draft, postedUrl: "u" }, "c1", { status: "kept" })).toThrow("Already posted");
  });
});
