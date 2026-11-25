import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compareCommits, completeCompare, latestReviewBy, reviewRequests, reviewsBy } from "../server/github";
import { Inbox, type InboxDeps } from "../server/inbox";
import { postDraft } from "../server/post";
import { filesAt, reanchorRun, recapRun, sinceRun } from "../server/rereview";
import { ReviewStore } from "../server/reviews";
import { callTool } from "../server/tools";
import { DISMISSED, plan, reopen, runId, setRun, type Pr, type State } from "../shared/inbox";
import { parsePatch } from "../shared/diff";
import { unifiedPatch } from "../shared/linediff";
import { buildRecap, lookLabel, preview, priorSection, splitPath, RecapSchema, threadCommits, threadStatus, touchedSince, triage, type Thread } from "../shared/recap";
import { anchorAt, askedAgain, locate, reanchorDraft, sideLines, sinceBase, sinceChanges, type Compare, type ReviewRequest, type Since } from "../shared/rereview";
import { composeReview, effectiveVerdict, RecapInputSchema, toDraft, updateComment, ReviewInputSchema, type PrDetails, type PrFile } from "../shared/review";
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
  it("counts the true total of left-out files, keeps only the PR's own commits, and flags a partial list", () => {
    const merged = compare({ commits: [{ sha: B, message: "Fix tax" }, { sha: "m1", message: "Main's commit" }], totalFiles: 653 });
    expect(sinceChanges({ sha: A, from: "posted" }, B, merged, paths, new Set([B]))).toMatchObject({ commits: [{ sha: B }], hidden: 652 });
    expect(sinceChanges({ sha: A, from: "posted" }, B, merged, paths)).not.toHaveProperty("incomplete");
    expect(sinceChanges({ sha: A, from: "posted" }, B, { ...merged, truncated: true }, paths)).toMatchObject({ incomplete: true, hidden: 652 });
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
      return draft ? { posted: Boolean(draft.postedUrl), verdict: effectiveVerdict(draft) } : null;
    },
    ...overrides,
  });
  await inbox.poll();
  await callTool(inbox, reviews, "agent-1", "inbox_review_draft", { verdict: "approve", confidence: 90, summary: "Fine.", comments: [{ path: PATH, line: 4, body: "Sum skips discounts." }] }, NOW);
  return { inbox, reviews, state: () => state, runId: state.runs[0]!.id };
}

const details = (headSha: string, files: PrFile[]): PrDetails => ({ body: "", author: "ola", baseRef: "main", headRef: "x", headSha, additions: 1, deletions: 0, changedFiles: files.length, createdAt: NOW, closedAt: null, mergedAt: null, files, threads: [], title: "t", requestedReviewers: [] });

describe("postable drafts", () => {
  it("lists a draft waiting on the human with the verdict it posts as, until it is posted", async () => {
    const { inbox, reviews, runId: id } = await drafted();
    expect(inbox.view().postable).toEqual({ [id]: "approve" });
    reviews.save({ ...reviews.get(id)!, verdictOverride: "comment" });
    expect(inbox.view().postable).toEqual({ [id]: "comment" });
    await postDraft(inbox, reviews, id, async () => "https://github.com/acme/shop/pull/7#pullrequestreview-1", async () => details(A, [file(OLD)]), NOW);
    expect(inbox.view().postable).toEqual({});
  });

  it("drops the draft once a push makes its run stale", async () => {
    let head = A;
    const { inbox, runId: id } = await drafted({}, () => [pr({ headSha: head })]);
    expect(Object.keys(inbox.view().postable ?? {})).toEqual([id]);
    head = B;
    await inbox.poll();
    expect(inbox.view().postable).toEqual({});
  });
});

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
    expect(await compareCommits("acme/shop", A, B, async () => out)).toEqual({ status: "ahead", behindBy: 0, commits: [{ sha: B, message: "Fix" }], files: [{ path: PATH, status: "modified", additions: 1, deletions: 0, patch: "@@", previousPath: undefined }], truncated: false });
  });

  it("finds my latest submitted review and the timeline's review requests", async () => {
    const reviewsOut = JSON.stringify([[
      { id: 1, user: { login: "Jacek" }, state: "COMMENTED", commit_id: A, submitted_at: later(1), html_url: "r1" },
      { id: 2, user: { login: "jacek" }, state: "APPROVED", commit_id: B, submitted_at: later(9), html_url: "r2" },
      { id: 3, user: { login: "jacek" }, state: "PENDING", commit_id: "c", submitted_at: null, html_url: "r3" },
      { id: 4, user: { login: "kuba" }, state: "APPROVED", commit_id: "d", submitted_at: later(20), html_url: "r4" },
    ]]);
    expect(await latestReviewBy("acme/shop", 7, "jacek", async () => reviewsOut)).toEqual({ id: "2", state: "APPROVED", commit: B, at: later(9), url: "r2" });
    expect((await reviewsBy("acme/shop", 7, "jacek", async () => reviewsOut)).map((review) => [review.id, review.state])).toEqual([["2", "APPROVED"], ["1", "COMMENTED"]]);
    const timeline = JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { nodes: [
      { createdAt: later(1), actor: { login: "ola" }, requestedReviewer: { __typename: "User", login: "jacek" } },
      { createdAt: later(2), actor: { login: "ola" }, requestedReviewer: { __typename: "Team" } },
    ] } } } } });
    const run = vi.fn(async (_args: string[]) => timeline);
    expect(await reviewRequests("acme/shop", 7, run)).toEqual([{ at: later(1), reviewer: "jacek", by: "ola" }, { at: later(2), reviewer: null, by: "ola" }]);
    expect(run.mock.calls[0]![0]).toEqual(expect.arrayContaining(["graphql", "owner=acme", "name=shop", "number=7"]));
  });
});

describe("since your review: recap", () => {
  const me = "jacek";
  const comment = (author: string, body: string, minutes: number, reviewId: string | null = null) => ({ id: `${author}-${minutes}`, author, body, url: `u/${author}-${minutes}`, at: later(minutes), reviewId });
  const thread = (id: string, overrides: Partial<Thread> = {}): Thread => ({
    id,
    path: PATH,
    line: 4,
    resolved: false,
    outdated: false,
    comments: [comment("Jacek", `About ${id}.`, 1, "r1")],
    ...overrides,
  });
  // The since diff changes line 4 of the file at A (old side) = line 4 at B (new side).
  const changed: PrFile = { path: PATH, status: "modified", additions: 1, deletions: 1, patch: "@@ -3,3 +3,3 @@\n function total() {\n-  return sum(items);\n+  return sum(items, discounts);\n }" };
  const changes: Since = { kind: "changes", base: A, head: B, from: "posted", commits: [{ sha: B, message: "Fix" }], files: [changed], hidden: 0 };

  it("finds the lines a since diff touched, on either side, including inserts right after them", () => {
    expect(touchedSince(thread("t", { commit: A, originalLine: 4, line: null }), changes)).toBe(true);
    expect(touchedSince(thread("t", { commit: A, originalLine: 8, line: 8 }), changes)).toBe(false);
    // Written on an older round: GitHub's current line (at the head) is checked on the new side.
    expect(touchedSince(thread("t", { commit: "old", originalLine: 2, line: 4 }), changes)).toBe(true);
    expect(touchedSince(thread("t", { commit: "old", originalLine: 2, line: 2 }), changes)).toBe(false);
    const insert: PrFile = { ...changed, patch: "@@ -4,2 +4,3 @@\n   return sum(items);\n+  // checked\n }" };
    expect(touchedSince(thread("t", { commit: A, originalLine: 4 }), { ...changes, files: [insert] })).toBe(true);
    expect(touchedSince(thread("t", { commit: A, originalLine: 2, originalStartLine: 1 }), { ...changes, files: [insert] })).toBe(false);
    // A whole-file comment counts any change to its file; another file's change doesn't.
    expect(touchedSince(thread("t", { line: null, originalLine: null }), changes)).toBe(true);
    expect(touchedSince(thread("t", { path: "other.ts" }), changes)).toBe(false);
    expect(touchedSince(thread("t", { commit: A, originalLine: 4 }), { kind: "rewritten", base: A, from: "posted", why: "diverged" })).toBe(false);
  });

  it("judges a thread from an earlier round by the diff since its own commit", () => {
    const earlier = thread("t", { commit: "old", originalLine: 4, line: 9 });
    expect(touchedSince(earlier, { kind: "same", base: A, from: "posted" })).toBe(false);
    expect(touchedSince(earlier, { kind: "same", base: A, from: "posted" }, new Map([["old", { files: [changed] }]]))).toBe(true);
    expect(touchedSince(earlier, changes, new Map([["old", { files: [] }]]))).toBe(false);
    // GitHub listed only part of that diff and the thread's file isn't in it: can't tell.
    expect(touchedSince(earlier, changes, new Map([["old", { files: [], incomplete: true }]]))).toBeNull();
    expect(touchedSince(earlier, changes, new Map([["old", { files: [changed], incomplete: true }]]))).toBe(true);
    expect(touchedSince(thread("t", { commit: A, originalLine: 9, line: 9, path: "gone.ts" }), { ...changes, incomplete: true })).toBeNull();
    const threads = [earlier, thread("base", { commit: A }), thread("done", { commit: "x", resolved: true }), thread("again", { commit: "old" }), thread("other", { commit: "y", comments: [comment("kuba", "Hi", 1)] })];
    expect(threadCommits(threads, me, changes)).toEqual(["old"]);
  });

  it("says what happened to each of my comments without reading the code", () => {
    const status = (overrides: Partial<Thread>, since: Since = changes) => threadStatus(thread("t", overrides), me, since);
    expect(status({ resolved: true, line: 9, commit: A, originalLine: 9 })).toMatchObject({ status: "fixed", why: "resolved" });
    expect(status({ commit: A, originalLine: 4 })).toMatchObject({ status: "fixed", why: "changed" });
    expect(status({ commit: A, originalLine: 9, line: 9, outdated: true })).toMatchObject({ status: "outdated" });
    const replied = status({ commit: A, originalLine: 9, line: 9, comments: [comment("jacek", "Why?", 1), comment("ola", "On purpose.", 5), comment("coderabbit[bot]", "Noted", 6), comment("jacek", "Hm", 7)] });
    expect(replied).toMatchObject({ status: "pushed-back", body: "Why?", reply: { author: "ola", body: "On purpose." } });
    expect(status({ commit: A, originalLine: 9, line: 9 })).toMatchObject({ status: "unanswered", reply: null });
    // An incomplete diff never yields "pushed back" or "unanswered" for a file it doesn't list.
    const partial: Since = { ...changes, files: [], incomplete: true };
    expect(status({ commit: A, originalLine: 9, line: 9, comments: [comment("jacek", "Why?", 1), comment("ola", "On purpose.", 5)] }, partial)).toMatchObject({ status: "unknown", reply: { author: "ola" } });
    expect(status({ commit: A, originalLine: 9, line: 9 }, partial)).toMatchObject({ status: "unknown" });
    expect(status({ resolved: true }, partial)).toMatchObject({ status: "fixed" });
    expect(priorSection(buildRecap(partial, [thread("t", { commit: A, originalLine: 9, line: 9 })], [], me, null)).join("\n")).toContain("unknown (GitHub listed only part of the diff)");
  });

  it("lists my past reviews with their comment counts, and only my threads, those needing me first", () => {
    const threads = [
      thread("fixed", { resolved: true }),
      thread("open", { line: 9, commit: A, originalLine: 9 }),
      thread("theirs", { comments: [comment("kuba", "Mine", 1)] }),
      thread("answered", { line: 9, commit: A, originalLine: 9, comments: [comment("jacek", "Q", 1, "r2"), comment("ola", "A", 2)] }),
    ];
    const reviews = [
      { id: "r2", state: "COMMENTED", commit: A, at: later(2), url: "r2" },
      { id: "r1", state: "CHANGES_REQUESTED", commit: "old", at: later(1), url: "r1" },
    ];
    const recap = buildRecap(changes, threads, reviews, me, null);
    expect(recap.reviews).toEqual([
      { id: "r2", state: "COMMENTED", commit: A, at: later(2), url: "r2", comments: 1 },
      { id: "r1", state: "CHANGES_REQUESTED", commit: "old", at: later(1), url: "r1", comments: 2 },
    ]);
    expect(recap.comments.map((item) => [item.thread, item.status])).toEqual([
      ["answered", "pushed-back"],
      ["open", "unanswered"],
      ["fixed", "fixed"],
    ]);
    expect(RecapSchema.safeParse(recap).success).toBe(true);
  });

  it("after a force-push, still gives the statuses it can and tells the reviewer to look again in full", () => {
    const rewritten: Since = { kind: "rewritten", base: A, from: "posted", why: "unreachable" };
    const recap = buildRecap(rewritten, [thread("t", { commit: A, originalLine: 4 }), thread("r", { resolved: true })], [], me, null);
    expect(recap.comments.map((item) => item.status)).toEqual(["unanswered", "fixed"]);
    const text = priorSection(recap).join("\n");
    expect(text).toContain("No clean diff since aaaaaaa");
    expect(text).toContain('"full"');
  });

  it("gives the reviewer my earlier threads by id and the diff since my review", () => {
    const recap = buildRecap(changes, [thread("PRRT_1", { commit: A, originalLine: 4, comments: [comment("jacek", "Discounts are skipped.", 1, "r1"), comment("ola", "Fixed.", 3)] })], [{ id: "r1", state: "CHANGES_REQUESTED", commit: A, at: later(1), url: "r1" }], me, null);
    const text = priorSection(recap).join("\n");
    expect(text).toContain("## Your previous review");
    expect(text).toContain("thread PRRT_1 · src/basket/BasketPage.tsx:4 · fixed (code changed): Discounts are skipped.");
    expect(text).toContain('last reply @ola: "Fixed."');
    expect(text).toContain("changes requested on aaaaaaa (1 comment)");
    expect(text).toContain("+  return sum(items, discounts);");
    expect(priorSection(buildRecap({ kind: "none" }, [], [], me, null))).toEqual([]);
  });

  it("sorts the reviewer's triage riskiest first and counts what to check", () => {
    const ai = RecapInputSchema.parse({ look: "check", check: ["Discount rounding"], changes: [{ path: "b.ts", risk: "mechanical" }, { path: "a.ts", risk: "logic", note: "New branch" }] });
    expect(triage(ai.changes).map((change) => change.path)).toEqual(["a.ts", "b.ts"]);
    expect(lookLabel(ai)).toBe("Check 1 thing");
    expect(lookLabel({ ...ai, check: ["x", "y"] })).toBe("Check 2 things");
    expect(lookLabel({ ...ai, look: "full" })).toBe("Full re-look");
    expect(preview("⚠️ **minor** — A role that calls `createParty`\n\nforgets **it**.")).toBe("A role that calls createParty forgets it.");
    expect(preview("🎨 **nit** — Rename.")).toBe("Rename.");
    expect(splitPath("packages/core/write.ts")).toEqual({ dir: "packages/core/", name: "write.ts" });
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
  });
});

describe("recapRun", () => {
  it("reads my threads and reviews only when there is a prior review, and keeps the reviewer's verdicts", async () => {
    const { inbox, reviews, runId: id } = await drafted();
    reviews.save({ ...reviews.get(id)!, recap: RecapInputSchema.parse({ look: "full", why: "Rewritten." }) });
    const threads = vi.fn(async (): Promise<Thread[]> => [{ id: "t1", path: PATH, line: 4, resolved: true, outdated: false, comments: [{ id: "c", author: "jacek", body: "x", url: "u", at: NOW, reviewId: "1" }] }]);
    const reviewsBy = vi.fn(async () => [{ id: "1", state: "COMMENTED", commit: "ppppppp000", at: NOW, url: "u" }]);
    const base = { details: async () => details(A, [file(OLD)]), me: async () => "jacek", compare: async (): Promise<Compare> => ({ status: "ahead", behindBy: 0, commits: [], files: [file(OLD)] }), threads, reviewsBy };
    const recap = await recapRun(inbox, reviews, id, { ...base, latestReview: async () => ({ commit: "ppppppp000", at: NOW, url: "u" }) });
    expect(recap).toMatchObject({ since: { kind: "changes" }, reviews: [{ comments: 1 }], comments: [{ status: "fixed" }], ai: { look: "full" } });
    // An open thread from an earlier round: compared from its own commit too.
    const compare = vi.fn(async (_repo: string, from: string): Promise<Compare> => ({ status: "ahead", behindBy: 0, commits: [], files: from === "eeeeeee999" ? [{ ...file(OLD), status: "modified", patch: "@@ -4,1 +4,1 @@\n-  return 0;\n+  return sum(items);" }] : [] }));
    threads.mockResolvedValueOnce([{ id: "t2", path: PATH, line: 4, resolved: false, outdated: false, commit: "eeeeeee999", originalLine: 4, comments: [{ id: "c", author: "jacek", body: "x", url: "u", at: NOW, reviewId: "1" }] }]);
    const earlier = await recapRun(inbox, reviews, id, { ...base, compare, latestReview: async () => ({ commit: "ppppppp000", at: NOW, url: "u" }) });
    expect(compare.mock.calls.map(([, from]) => from)).toEqual(["ppppppp000", "eeeeeee999"]);
    expect(earlier.comments).toMatchObject([{ status: "fixed", why: "changed" }]);
    threads.mockClear();
    expect(await recapRun(inbox, reviews, id, { ...base, latestReview: async () => null })).toEqual({ since: { kind: "none" }, reviews: [], comments: [], ai: null });
    expect(threads).not.toHaveBeenCalled();
    const failing = await recapRun(inbox, reviews, id, { ...base, latestReview: async () => ({ commit: "ppppppp000", at: NOW, url: "u" }), threads: async () => Promise.reject(new Error("rate limited")) });
    expect(failing).toMatchObject({ since: { kind: "changes" }, comments: [], error: "Couldn't read your earlier comments: rate limited" });
  });

  it("puts the prior review into inbox_pr for the reviewer", async () => {
    const { inbox, reviews } = await drafted();
    const prior = vi.fn(async () => ["## Your previous review", "thread t1 · fixed"]);
    const result = await callTool(inbox, reviews, "agent-1", "inbox_pr", {}, NOW, async () => details(A, [file(OLD)]), prior);
    expect(result.text).toContain("## Your previous review");
    expect(result.text.indexOf("## Your previous review")).toBeLessThan(result.text.indexOf("## Diff"));
    const broken = await callTool(inbox, reviews, "agent-1", "inbox_pr", {}, NOW, async () => details(A, [file(OLD)]), async () => Promise.reject(new Error("x")));
    expect(broken.isError).toBeFalsy();
  });
});

describe("unifiedPatch (rebuilding a file GitHub's compare left out)", () => {
  /** Applies a patch to `before` by its hunks, to check it reproduces `after`. */
  const apply = (before: string, patch: string) => {
    const old = before.split("\n");
    const out: string[] = [];
    let at = 1;
    for (const hunk of parsePatch(patch)) {
      const first = hunk.lines.find((line) => line.old !== undefined)?.old ?? Number(/-(\d+)/.exec(hunk.header)![1]) + 1;
      while (at < first) out.push(old[at++ - 1]!);
      for (const line of hunk.lines) {
        if (line.kind !== "del") out.push(line.text);
        if (line.kind !== "add") at++;
      }
    }
    while (at <= old.length) out.push(old[at++ - 1]!);
    return out.join("\n");
  };

  it("writes GitHub-style hunks with three lines of context and the counts", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n");
    const after = ["a", "b", "c", "d", "E", "f", "g", "h", "i", "j", "k"].join("\n");
    expect(unifiedPatch(before, after)).toEqual({
      patch: "@@ -2,9 +2,10 @@\n b\n c\n d\n-e\n+E\n f\n g\n h\n i\n j\n+k",
      additions: 2,
      deletions: 1,
    });
    expect(unifiedPatch("", "x\ny\n")).toEqual({ patch: "@@ -0,0 +1,2 @@\n+x\n+y", additions: 2, deletions: 0 });
    expect(unifiedPatch("same\n", "same\n")).toEqual({ patch: "", additions: 0, deletions: 0 });
  });

  it("round-trips scattered edits, and gives up past its edit budget", () => {
    const before = Array.from({ length: 200 }, (_, index) => `line ${index}`);
    const after = before.flatMap((line, index) => (index % 37 === 0 ? [] : index % 23 === 0 ? [line, `new ${index}`] : index % 41 === 0 ? [`changed ${index}`] : [line]));
    const result = unifiedPatch(before.join("\n"), after.join("\n"))!;
    expect(apply(before.join("\n"), result.patch)).toBe(after.join("\n"));
    expect(result.patch.split("\n").filter((line) => line.startsWith("@@")).length).toBeGreaterThan(1);
    expect(unifiedPatch(before.join("\n"), after.join("\n"), 3, 5)).toBeNull();
  });
});


describe("GitHub's 300-file compare cap", () => {
  const files = (count: number) => Array.from({ length: count }, (_, index) => ({ filename: `main/${index}.ts`, status: "modified", additions: 1, deletions: 0, patch: "@@" }));
  it("marks a compare that hit the cap as truncated", async () => {
    const out = (count: number) => JSON.stringify({ status: "ahead", behind_by: 0, commits: [], files: files(count) });
    expect((await compareCommits("acme/shop", A, B, async () => out(300)))!.truncated).toBe(true);
    expect((await compareCommits("acme/shop", A, B, async () => out(12)))!.truncated).toBe(false);
  });

  it("completes the PR's files from the two trees, rebuilding the patches the compare left out", async () => {
    // What `--jq` leaves of GitHub's tree: [path, blob sha] pairs.
    const tree = (entries: [string, string][]) => JSON.stringify({ truncated: false, tree: entries });
    const blob = (text: string) => JSON.stringify({ encoding: "base64", content: Buffer.from(text).toString("base64") });
    const run = vi.fn(async (args: string[]) => {
      const path = args.find((arg) => arg.startsWith("repos/"))!;
      if (path.includes(`/git/trees/${A}`)) return tree([[PATH, "old"], ["same.ts", "s"], ["main/a.ts", "1"], ["main/b.ts", "2"], ["removed.ts", "r"]]);
      if (path.includes(`/git/trees/${B}`)) return tree([[PATH, "new"], ["same.ts", "s"], ["main/a.ts", "1x"], ["main/b.ts", "2x"], ["added.ts", "n"]]);
      if (path.endsWith("/git/blobs/old")) return blob(OLD.join("\n") + "\n");
      if (path.endsWith("/git/blobs/new")) return blob(OLD.map((line) => line.replace("return 0;", "return rate;")).join("\n") + "\n");
      throw new Error(`unexpected ${path}`);
    });
    const truncated = { status: "ahead", behindBy: 0, commits: [], files: [], truncated: true };
    const complete = await completeCompare("acme/shop", A, B, truncated, new Set([PATH, "same.ts"]), run);
    expect(complete).toMatchObject({ truncated: false, totalFiles: 5, files: [{ path: PATH, status: "modified", additions: 1, deletions: 1 }] });
    expect(complete!.files[0]!.patch).toContain("-  return 0;\n+  return rate;");
    expect(run.mock.calls.filter(([args]) => args.some((arg) => arg.includes("/git/blobs/")))).toHaveLength(2);
    // A tree GitHub cut short can't be trusted: no completion.
    const short = vi.fn(async () => JSON.stringify({ truncated: true, tree: [] }));
    expect(await completeCompare("acme/shop", A, B, truncated, new Set([PATH]), short)).toBeNull();
  });

  it("uses the completed diff in the recap, and says unknown when it can't complete", async () => {
    const { inbox, reviews, runId: id } = await drafted();
    const thread: Thread = { id: "t1", path: PATH, line: 9, resolved: false, outdated: false, commit: "ppppppp000", originalLine: 9, comments: [{ id: "c", author: "jacek", body: "x", url: "u", at: NOW, reviewId: "1" }] };
    const deps = {
      details: async () => details(A, [file(OLD)]),
      me: async () => "jacek",
      latestReview: async () => ({ commit: "ppppppp000", at: NOW, url: "u" }),
      compare: async (): Promise<Compare> => ({ status: "ahead", behindBy: 0, commits: [{ sha: A, message: "Mine" }, { sha: "m1", message: "From main" }], files: [], truncated: true }),
      threads: async () => [thread],
      reviewsBy: async () => [],
      ownCommits: async () => new Set([A]),
    };
    const unknown = await recapRun(inbox, reviews, id, { ...deps, complete: async () => null });
    expect(unknown).toMatchObject({ since: { kind: "changes", incomplete: true, commits: [{ sha: A }] }, comments: [{ status: "unknown" }] });
    const edit = { ...file(OLD), status: "modified", patch: "@@ -9,1 +9,1 @@\n-}\n+};" };
    const complete = vi.fn(async (): Promise<Compare> => ({ status: "ahead", behindBy: 0, commits: [], files: [edit], truncated: false, totalFiles: 900 }));
    const fixed = await recapRun(inbox, reviews, id, { ...deps, complete });
    expect(fixed).toMatchObject({ since: { kind: "changes", hidden: 899 }, comments: [{ status: "fixed", why: "changed" }] });
    expect(fixed.since).not.toHaveProperty("incomplete");
  });
});
