import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compareCommits, latestReviewBy, reviewRequests } from "../server/github";
import { Inbox, type InboxDeps } from "../server/inbox";
import { postDraft } from "../server/post";
import { filesAt, reanchorRun, sinceRun } from "../server/rereview";
import { ReviewStore } from "../server/reviews";
import { callTool } from "../server/tools";
import { DISMISSED, plan, reopen, runId, setRun, type Pr, type State } from "../shared/inbox";
import { anchorAt, askedAgain, locate, reanchorDraft, sideLines, sinceBase, sinceChanges, type Compare, type ReviewRequest } from "../shared/rereview";
import { composeReview, toDraft, updateComment, ReviewInputSchema, type PrDetails, type PrFile } from "../shared/review";
import { config, emptyState, later, NOW, pr } from "./fixtures";

const PATH = "src/basket/BasketPage.tsx";
const A = "aaaaaaa111";
const B = "bbbbbbb222";

/** A patch adding `lines` as a new file, so line N of the file is diff line N. */
const added = (lines: string[]) => `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}`;
const file = (lines: string[], path = PATH, extra: Partial<PrFile> = {}): PrFile => ({ path, status: "added", additions: lines.length, deletions: 0, patch: added(lines), ...extra });

const OLD = ["import x", "", "function total() {", "  return sum(items);", "}", "", "function tax() {", "  return 0;", "}"];

function draftWith(comments: { line: number | null; body: string; path?: string; side?: "LEFT" | "RIGHT" }[]) {
  const input = ReviewInputSchema.parse({ verdict: "request-changes", confidence: 70, summary: "Adds totals.", comments: comments.map((comment) => ({ path: PATH, severity: "minor", ...comment })) });
  return toDraft(input, { id: runId("acme/shop#7", "draft-review", A), itemKey: "acme/shop#7", version: A }, NOW);
}
const to = { version: B, runId: runId("acme/shop#7", "draft-review", B) };

describe("locate", () => {
  const lines = sideLines(added(OLD)).RIGHT;
  it("keeps an unchanged line, finds a unique moved one, and rejects a changed one", () => {
    const anchor = anchorAt(lines, 4, A)!;
    expect(locate(anchor, lines, 4)).toBe(4);
    expect(locate(anchor, sideLines(added(["// new", ...OLD])).RIGHT, 4)).toBe(5);
    expect(locate(anchor, sideLines(added(OLD.map((line) => line.replace("sum(items)", "sum(items, tax)")))).RIGHT, 4)).toBeNull();
  });

  it("tells repeated lines apart by their neighbours, and gives up when they can't", () => {
    // "}" closes both functions; the comment is on the second.
    const anchor = anchorAt(lines, 9, A)!;
    expect(locate(anchor, sideLines(added(["// header", ...OLD])).RIGHT, 9)).toBe(10);
    const twins = sideLines(added(["{", "x", "}", "{", "x", "}"])).RIGHT;
    expect(locate(anchorAt(twins, 3, A)!, sideLines(added(["", "{", "x", "}", "{", "x", "}"])).RIGHT, 3)).toBeNull();
  });
});

describe("reanchorDraft", () => {
  it("moves, drifts, and keeps every human decision; the summary stays labelled for the old commit", () => {
    let draft = draftWith([
      { line: 4, body: "Sum skips discounts." }, // moves down by one
      { line: 8, body: "Tax is always zero." }, // its line is rewritten → drifted
      { line: null, body: "Needs tests." }, // whole file: unchanged
    ]);
    draft = updateComment(draft, "c1", { body: "Sum skips discounts; see #12." });
    draft = updateComment(draft, "c2", { status: "dropped" });
    const next = ["// header", ...OLD.map((line) => line.replace("return 0;", "return rate * total();"))];
    const result = reanchorDraft(draft, [file(OLD)], [file(next)], to, later(5));
    expect(result).toMatchObject({ moved: 1, drifted: 1, unchanged: 1 });
    const [c1, c2, c3] = result.draft.comments;
    expect(c1).toMatchObject({ line: 5, originalLine: 4, status: "edited", body: "Sum skips discounts; see #12.", drifted: false });
    expect(c2).toMatchObject({ line: 8, drifted: true, status: "dropped", anchor: { text: "  return 0;", version: A } });
    expect(c3).toMatchObject({ line: null });
    expect(result.draft).toMatchObject({ version: B, runId: to.runId, reviewedVersion: A, reanchored: { from: A, moved: 1, drifted: 1 }, summary: "Adds totals.", verdict: "request-changes" });
  });

  it("follows a rename, and keeps anchors so a later move matches the same code and can un-drift", () => {
    const draft = draftWith([{ line: 4, body: "Sum skips discounts." }]);
    const renamed = "src/basket/Totals.tsx";
    const first = reanchorDraft(draft, [file(OLD)], [file(OLD.map((line) => line.replace("sum(items)", "add(items)")))], to, NOW).draft;
    expect(first.comments[0]).toMatchObject({ drifted: true, line: 4 });
    // The next head puts the line back, under a new name; no old diff is needed now.
    const C = "ccccccc333";
    const second = reanchorDraft(first, null, [file(["// moved", ...OLD], renamed, { previousPath: PATH, status: "renamed" })], { version: C, runId: "x" }, NOW);
    expect(second.draft.comments[0]).toMatchObject({ path: renamed, line: 5, drifted: false, originalLine: 4 });
    expect(second.draft).toMatchObject({ reviewedVersion: A, reanchored: { from: B } });
  });

  it("drifts everything when the old diff is unknown, and refuses a posted draft", () => {
    const draft = draftWith([{ line: 4, body: "x" }]);
    expect(reanchorDraft(draft, null, [file(OLD)], to, NOW).drifted).toBe(1);
    expect(() => reanchorDraft({ ...draft, postedUrl: "u" }, [file(OLD)], [file(OLD)], to, NOW)).toThrow("Already posted");
  });

  it("posts at the new head: moved comments inline, drifted ones in the body with the code they were about", () => {
    const draft = draftWith([{ line: 4, body: "Sum skips discounts." }, { line: 8, body: "Tax is always zero." }]);
    const next = [file(["// header", ...OLD.map((line) => line.replace("return 0;", "return rate;"))])];
    const { draft: moved } = reanchorDraft(draft, [file(OLD)], next, to, NOW);
    const composed = composeReview(moved, next);
    expect(composed.payload.commit_id).toBe(B);
    expect(composed.payload.comments).toEqual([{ path: PATH, line: 5, side: "RIGHT", body: "⚠️ **minor** — Sum skips discounts." }]);
    expect(composed.payload.body).toContain("- `src/basket/BasketPage.tsx` (line 8 at aaaaaaa, `return 0;`; changed since) — ⚠️ **minor** — Tax is always zero.");
    expect(composed.payload.body).toContain("Reviewed at aaaaaaa; the comments were moved to bbbbbbb without a new review.");
  });
});

describe("since my last review", () => {
  const mine = { commit: "ppppppp000", at: later(1), url: "u" };
  it("picks the stale draft's commit, then the summary's, then my posted review's", () => {
    expect(sinceBase({ version: A }, B, mine)).toEqual({ sha: A, from: "draft" });
    expect(sinceBase({ version: B, reviewedVersion: A }, B, mine)).toEqual({ sha: A, from: "reviewed" });
    expect(sinceBase({ version: B }, B, mine)).toEqual({ sha: "ppppppp000", from: "posted", at: mine.at });
    expect(sinceBase(null, B, null)).toBeNull();
  });

  const compare = (overrides: Partial<Compare> = {}): Compare => ({ status: "ahead", behindBy: 0, commits: [{ sha: B, message: "Fix tax" }], files: [file(OLD), file(["x"], "src/merged-from-main.ts")], ...overrides });
  const paths = new Set([PATH]);
  it("shows what changed, without files the base branch merged in", () => {
    expect(sinceChanges({ sha: A, from: "posted" }, B, compare(), paths)).toMatchObject({ kind: "changes", base: A, head: B, commits: [{ message: "Fix tax" }], files: [{ path: PATH }], hidden: 1 });
  });
  it("says so when the commit is gone or history was rewritten, and when nothing changed", () => {
    expect(sinceChanges({ sha: A, from: "draft" }, B, null, paths)).toEqual({ kind: "rewritten", base: A, from: "draft", why: "unreachable" });
    expect(sinceChanges({ sha: A, from: "draft" }, B, compare({ status: "diverged", behindBy: 2 }), paths)).toMatchObject({ kind: "rewritten", why: "diverged" });
    expect(sinceChanges({ sha: B, from: "posted", at: NOW }, B, null, paths)).toEqual({ kind: "same", base: B, from: "posted", at: NOW });
    expect(sinceChanges(null, B, null, paths)).toEqual({ kind: "none" });
  });
});

describe("asked again", () => {
  const requests: ReviewRequest[] = [
    { at: later(1), reviewer: "Jacek", by: "ola" },
    { at: later(30), reviewer: null, by: "ola" },
    { at: later(20), reviewer: "kuba", by: "ola" },
  ];
  it("counts only requests naming me, after I settled it", () => {
    expect(askedAgain(requests, "jacek", later(0))).toMatchObject({ at: later(1) });
    expect(askedAgain(requests, "jacek", later(5))).toBeNull();
    expect(askedAgain([...requests, { at: later(40), reviewer: "jacek", by: "ola" }], "jacek", later(5))).toMatchObject({ at: later(40) });
  });

  const settled = (state: "done", reason: string, version = A): State => {
    const base = plan({ config: config(), results: { review: [pr({ headSha: version })] }, state: emptyState(), now: NOW });
    return setRun(base, base.runs[0]!.id, { state, reason }, later(1));
  };
  const ask = { at: later(2), by: "ola" };

  it("brings back an unposted draft at the same head, as it was", () => {
    const state = reopen(settled("done", DISMISSED), config(), settled("done", DISMISSED).runs[0]!, ask, { posted: false }, later(3));
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({ state: "needs-decision", reason: "review requested again by @ola: your draft is back" });
  });

  it("queues another round at the same head after a posted review, under its own id", () => {
    const before = settled("done", "review posted: u");
    const state = reopen(before, config(), before.runs[0]!, ask, { posted: true }, later(3));
    expect(state.runs.map((run) => [run.id, run.state])).toEqual([
      [runId("acme/shop#7", "draft-review", A), "done"],
      [`${runId("acme/shop#7", "draft-review", A)}|r2`, "queued"],
    ]);
    expect(state.runs[1]).toMatchObject({ round: 2, reason: "review requested again by @ola" });
  });

  it("queues the new head after a dismissal, and later pushes run again", () => {
    let state = settled("done", DISMISSED);
    state = plan({ config: config(), results: { review: [pr({ headSha: B })] }, state, now: later(2) });
    expect(state.runs).toHaveLength(1); // dismissed: the push alone does nothing
    state = reopen(state, config(), state.runs[0]!, ask, { posted: false }, later(3));
    expect(state.runs[1]).toMatchObject({ id: runId("acme/shop#7", "draft-review", B), state: "queued" });
    state = plan({ config: config(), results: { review: [pr({ headSha: "ccccccc333" })] }, state, now: later(4) });
    expect(state.runs.at(-1)).toMatchObject({ version: "ccccccc333", state: "queued" });
  });
});

/** An inbox with one review run at A drafted by agent-1. */
async function drafted(overrides: Partial<InboxDeps> = {}, results: () => Pr[] = () => [pr()]) {
  let state: State = emptyState();
  const reviews = new ReviewStore(mkdtempSync(join(tmpdir(), "inbox-rereview-")));
  let clock = 0;
  const inbox = new Inbox({
    loadConfig: () => config(),
    search: async (query) => (query.includes("review-requested") ? results() : []),
    start: async () => ({ agentId: "agent-1", workspaceId: "ws" }),
    load: () => state,
    save: (next) => (state = next),
    now: () => later(clock++),
    draftOf: (id) => {
      const draft = reviews.get(id);
      return draft ? { posted: Boolean(draft.postedUrl) } : null;
    },
    ...overrides,
  });
  await inbox.poll();
  await callTool(inbox, reviews, "agent-1", "inbox_review_draft", { verdict: "approve", confidence: 90, summary: "Fine.", comments: [{ path: PATH, line: 4, body: "Sum skips discounts." }] }, NOW);
  return { inbox, reviews, state: () => state, runId: state.runs[0]!.id };
}

const details = (headSha: string, files: PrFile[]): PrDetails => ({ body: "", author: "ola", baseRef: "main", headRef: "x", headSha, additions: 1, deletions: 0, changedFiles: files.length, createdAt: NOW, files, threads: [], title: "t", requestedReviewers: [] });

describe("reanchorRun", () => {
  it("moves the run to the live head, so Post sends the new commit; refuses when there's nothing to move", async () => {
    const { inbox, reviews, state, runId: from } = await drafted();
    const live = details(B, [file(["// header", ...OLD])]);
    const deps = { details: async () => live, filesAt: filesAt(() => null, async () => ({ status: "ahead", behindBy: 0, commits: [], files: [file(OLD)] })) };
    const result = await reanchorRun(inbox, reviews, from, deps, NOW);
    expect(result).toEqual({ runId: runId("acme/shop#7", "draft-review", B), moved: 1, drifted: 0, unchanged: 0 });
    expect(state().runs.map((run) => [run.version, run.state, run.agentId])).toEqual([
      [A, "done", "agent-1"],
      [B, "needs-decision", "agent-1"],
    ]);
    expect(inbox.item("acme/shop#7")!.pr.headSha).toBe(B);
    const post = vi.fn(async (_repo: string, _number: number, _payload: unknown) => "https://github.com/acme/shop/pull/7#pullrequestreview-2");
    await postDraft(inbox, reviews, result.runId, post, async () => live, NOW);
    expect(post.mock.calls[0]![2]).toMatchObject({ commit_id: B, comments: [{ line: 5 }] });
    await expect(reanchorRun(inbox, reviews, result.runId, deps)).rejects.toThrow("Already posted");
  });

  it("won't move onto a head that already has a draft, or a draft that's current", async () => {
    const { inbox, reviews, runId: from } = await drafted();
    await expect(reanchorRun(inbox, reviews, from, { details: async () => details(A, [file(OLD)]), filesAt: async () => null })).rejects.toThrow("already at the PR's head");
    reviews.save({ ...reviews.get(from)!, runId: runId("acme/shop#7", "draft-review", B), version: B });
    await expect(reanchorRun(inbox, reviews, from, { details: async () => details(B, [file(OLD)]), filesAt: async () => null })).rejects.toThrow("already a draft at bbbbbbb");
  });
});

describe("sinceRun", () => {
  it("compares from my posted review when the draft is at the head", async () => {
    const { inbox, reviews, runId: id } = await drafted();
    const compare = vi.fn(async (): Promise<Compare> => ({ status: "ahead", behindBy: 0, commits: [{ sha: A, message: "Fix" }], files: [file(OLD)] }));
    const since = await sinceRun(inbox, reviews, id, { details: async () => details(A, [file(OLD)]), me: async () => "jacek", latestReview: async () => ({ commit: "ppppppp000", at: NOW, url: "u" }), compare });
    expect(compare).toHaveBeenCalledWith("acme/shop", "ppppppp000", A);
    expect(since).toMatchObject({ kind: "changes", from: "posted", files: [{ path: PATH }] });
  });
});

describe("reopening from the poll", () => {
  it("reopens a posted review in a new round when re-requested, and reads the timeline only when the PR changed", async () => {
    let updatedAt = NOW;
    const requests = vi.fn(async (): Promise<ReviewRequest[]> => [{ at: later(500), reviewer: "jacek", by: "ola" }]);
    const { inbox, reviews, state, runId: id } = await drafted({ requests, me: async () => "jacek" }, () => [pr({ updatedAt })]);
    await postDraft(inbox, reviews, id, async () => "https://github.com/acme/shop/pull/7#pullrequestreview-1", async () => details(A, [file(OLD)]), NOW);
    expect(state().runs[0]!.state).toBe("done");
    requests.mockResolvedValueOnce([]);
    await inbox.poll();
    expect(requests).toHaveBeenCalledTimes(1);
    await inbox.poll(); // same updatedAt: no call
    expect(requests).toHaveBeenCalledTimes(1);
    updatedAt = later(501);
    await inbox.poll();
    expect(requests).toHaveBeenCalledTimes(2);
    expect(state().runs.map((run) => [run.id, run.state])).toEqual([
      [id, "done"],
      [`${id}|r2`, "running"],
    ]);
    // The new round's draft is its own file: saving it doesn't touch the posted one.
    expect((await callTool(inbox, reviews, "agent-1", "inbox_review_draft", { verdict: "approve", confidence: 90, summary: "Still fine." })).isError).toBeFalsy();
    expect(reviews.get(id)!.postedUrl).toBeTruthy();
    expect(reviews.get(`${id}|r2`)!.summary).toBe("Still fine.");
  });

  it("Rerun after a posted review starts another round instead of a draft that can't be saved", async () => {
    const { inbox, reviews, state, runId: id } = await drafted();
    await postDraft(inbox, reviews, id, async () => "u", async () => details(A, [file(OLD)]), NOW);
    await inbox.runNow("acme/shop#7", "draft-review");
    expect(state().runs.at(-1)).toMatchObject({ id: `${id}|r2`, round: 2 });
  });
});

describe("GitHub reads", () => {
  it("compare returns null when the base commit is gone", async () => {
    const gone = Object.assign(new Error("Command failed: gh api"), { stderr: "gh: Not Found (HTTP 404)" });
    expect(await compareCommits("acme/shop", A, B, async () => Promise.reject(gone))).toBeNull();
    await expect(compareCommits("acme/shop", A, B, async () => Promise.reject(new Error("timeout")))).rejects.toThrow("timeout");
    const out = JSON.stringify({ status: "ahead", behind_by: 0, commits: [{ sha: B, commit: { message: "Fix" } }], files: [{ filename: PATH, status: "modified", additions: 1, deletions: 0, patch: "@@" }] });
    expect(await compareCommits("acme/shop", A, B, async () => out)).toEqual({ status: "ahead", behindBy: 0, commits: [{ sha: B, message: "Fix" }], files: [{ path: PATH, status: "modified", additions: 1, deletions: 0, patch: "@@", previousPath: undefined }] });
  });

  it("finds my latest submitted review and the timeline's review requests", async () => {
    const reviewsOut = JSON.stringify([[
      { user: { login: "Jacek" }, state: "COMMENTED", commit_id: A, submitted_at: later(1), html_url: "r1" },
      { user: { login: "jacek" }, state: "APPROVED", commit_id: B, submitted_at: later(9), html_url: "r2" },
      { user: { login: "jacek" }, state: "PENDING", commit_id: "c", submitted_at: null, html_url: "r3" },
      { user: { login: "kuba" }, state: "APPROVED", commit_id: "d", submitted_at: later(20), html_url: "r4" },
    ]]);
    expect(await latestReviewBy("acme/shop", 7, "jacek", async () => reviewsOut)).toEqual({ commit: B, at: later(9), url: "r2" });
    const timeline = JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { nodes: [
      { createdAt: later(1), actor: { login: "ola" }, requestedReviewer: { __typename: "User", login: "jacek" } },
      { createdAt: later(2), actor: { login: "ola" }, requestedReviewer: { __typename: "Team" } },
    ] } } } } });
    const run = vi.fn(async (_args: string[]) => timeline);
    expect(await reviewRequests("acme/shop", 7, run)).toEqual([{ at: later(1), reviewer: "jacek", by: "ola" }, { at: later(2), reviewer: null, by: "ola" }]);
    expect(run.mock.calls[0]![0]).toEqual(expect.arrayContaining(["graphql", "owner=acme", "name=shop", "number=7"]));
  });
});
