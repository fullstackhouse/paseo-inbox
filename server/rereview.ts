import { runId as makeRunId } from "../shared/inbox";
import { buildRecap, threadCommits, type Recap, type Thread } from "../shared/recap";
import { reanchorDraft, sinceBase, sinceChanges, type Compare, type MyReview, type Since } from "../shared/rereview";
import type { PrDetails, PrFile } from "../shared/review";
import type { Inbox } from "./inbox";
import type { Details, FilesAt } from "./post";
import type { ReviewStore } from "./reviews";

export interface RereviewDeps {
  details: Details;
  filesAt: FilesAt;
}

/**
 * "Move comments to the new head": the draft's comments follow their code to GitHub's live head, the
 * human's decisions stay, and the run moves to that head so Post sends it with the new commit id.
 * Refused when the draft is posted or current, or when the new head already has a draft of its own.
 */
export async function reanchorRun(inbox: Inbox, reviews: ReviewStore, runId: string, deps: RereviewDeps, now = new Date().toISOString()) {
  const run = inbox.run(runId);
  const draft = reviews.get(runId);
  const item = run ? inbox.item(run.itemKey) : null;
  if (!run || !draft || !item) throw new Error("No review draft for this run");
  if (draft.postedUrl) throw new Error(`Already posted: ${draft.postedUrl}`);
  if (run.state === "running") throw new Error("The reviewer is still working on this draft");
  const live = await deps.details(item.pr.repo, item.pr.number);
  if (live.headSha === draft.version) throw new Error("This draft is already at the PR's head");
  const target = makeRunId(run.itemKey, run.rule, live.headSha);
  const there = inbox.run(target);
  if (there?.state === "running") throw new Error(`A fresh draft at ${live.headSha.slice(0, 7)} is being written; open it from the Inbox when it's ready`);
  if (reviews.get(target)) throw new Error(`There's already a draft at ${live.headSha.slice(0, 7)}; open it from the Inbox`);
  // Comments moved before carry their anchors; only a first move needs the old diff.
  const needsOld = draft.comments.some((comment) => comment.line !== null && !comment.anchor);
  const oldFiles = needsOld ? await deps.filesAt(item.pr.repo, item.pr.number, draft.version, live).catch(() => null) : [];
  const result = reanchorDraft(draft, oldFiles, live.files, { version: live.headSha, runId: target }, now);
  reviews.save(result.draft);
  const id = inbox.moved(runId, live.headSha);
  return { runId: id, moved: result.moved, drifted: result.drifted, unchanged: result.unchanged };
}

export interface SinceDeps {
  details: Details;
  me: () => Promise<string>;
  latestReview: (repo: string, number: number, me: string) => Promise<MyReview | null>;
  compare: (repo: string, base: string, head: string) => Promise<Compare | null>;
  /** Makes a compare that hit GitHub's 300-file cap whole for the PR's files; null when it can't. */
  complete?: (repo: string, base: string, head: string, compare: Compare, prPaths: ReadonlySet<string>) => Promise<Compare | null>;
  /** The PR's own commits, so the base branch's ones a merge brought in don't count; undefined = don't filter. */
  ownCommits?: (repo: string, number: number) => Promise<Set<string> | undefined>;
  /** Finished compares by repo, base and head. */
  cache?: CompareCache;
}

/**
 * Compares by `repo|base|head`, least recently used out first. Both commits are fixed, so a finished
 * result never goes stale; keeping it spares GitHub's rate limit the compares, trees and blobs a recap
 * would otherwise redo on every screen open and `inbox_pr` call.
 */
export class CompareCache {
  private readonly entries = new Map<string, Compare | null>();
  constructor(private readonly max = 100) {}
  has(key: string) {
    return this.entries.has(key);
  }
  get(key: string): Compare | null | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key)!;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }
  set(key: string, value: Compare | null) {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
  }
}

/** `base...head`, made whole when GitHub's list hit its cap (still `truncated` if that fails, and then not cached, so it's tried again). */
async function compareFor(deps: SinceDeps, repo: string, base: string, live: PrDetails, prPaths: ReadonlySet<string>): Promise<Compare | null> {
  const key = `${repo}|${base}|${live.headSha}`;
  const cached = deps.cache?.get(key);
  if (cached !== undefined) return cached;
  let compare = await deps.compare(repo, base, live.headSha);
  if (compare?.truncated && deps.complete) compare = (await deps.complete(repo, base, live.headSha, compare, prPaths).catch(() => null)) ?? compare;
  if (!compare?.truncated) deps.cache?.set(key, compare);
  return compare;
}

/** "Changes since my last review" for a run's PR: what changed between the commit the human last reviewed and the live head. */
export async function sinceRun(inbox: Inbox, reviews: ReviewStore, runId: string, deps: SinceDeps): Promise<Since> {
  return (await sinceFor(inbox, reviews, runId, deps)).since;
}

async function sinceFor(inbox: Inbox, reviews: ReviewStore, runId: string, deps: SinceDeps): Promise<{ since: Since; live: PrDetails }> {
  const run = inbox.run(runId);
  const item = run ? inbox.item(run.itemKey) : null;
  if (!run || !item) throw new Error("Unknown run");
  const draft = reviews.get(runId);
  const live = await deps.details(item.pr.repo, item.pr.number);
  const fromDraft = sinceBase(draft, live.headSha, null);
  // GitHub is asked only when the draft itself doesn't say what was reviewed before.
  const me = fromDraft ? "" : await deps.me().catch(() => "");
  const mine = me ? await deps.latestReview(item.pr.repo, item.pr.number, me).catch(() => null) : null;
  const base = fromDraft ?? sinceBase(draft, live.headSha, mine);
  const prPaths = new Set(live.files.map((file) => file.path));
  const moved = base && base.sha !== live.headSha;
  const [compare, own] = await Promise.all([moved ? compareFor(deps, item.pr.repo, base.sha, live, prPaths) : null, moved && deps.ownCommits ? deps.ownCommits(item.pr.repo, item.pr.number).catch(() => undefined) : undefined]);
  return { since: sinceChanges(base, live.headSha, compare, prPaths, own), live };
}

/** A clean diff from `base` to the head, with the PR's files only; null for rewritten history or a failed read. */
async function cleanDiff(deps: SinceDeps, repo: string, base: string, live: PrDetails): Promise<{ files: PrFile[]; incomplete?: boolean } | null> {
  const prPaths = new Set(live.files.map((file) => file.path));
  const compare = await compareFor(deps, repo, base, live, prPaths).catch(() => null);
  const since = sinceChanges({ sha: base, from: "posted" }, live.headSha, compare, prPaths);
  return since.kind === "changes" ? { files: since.files, incomplete: since.incomplete } : since.kind === "same" ? { files: [] } : null;
}

export interface RecapDeps extends SinceDeps {
  threads: (repo: string, number: number) => Promise<Thread[]>;
  reviewsBy: (repo: string, number: number, me: string) => Promise<MyReview[]>;
}

/**
 * "Since your review": the since diff plus the human's past reviews and what happened to each of their
 * threads, with the reviewer's verdicts from the draft. GitHub's threads are read only when there was a
 * prior review; if that read fails, the since diff still comes back, with the error.
 */
export async function recapRun(inbox: Inbox, reviews: ReviewStore, runId: string, deps: RecapDeps): Promise<Recap> {
  const { since, live } = await sinceFor(inbox, reviews, runId, deps);
  if (since.kind === "none") return buildRecap(since, [], [], "", null);
  const pr = inbox.item(inbox.run(runId)!.itemKey)!.pr;
  const ai = reviews.get(runId)?.recap ?? null;
  try {
    const me = await deps.me();
    const [threads, mine] = await Promise.all([deps.threads(pr.repo, pr.number), deps.reviewsBy(pr.repo, pr.number, me)]);
    // Threads from earlier rounds are judged by the diff since their own commit, not just since the last review.
    const diffs = new Map((await Promise.all(threadCommits(threads, me, since).map(async (commit) => [commit, await cleanDiff(deps, pr.repo, commit, live)] as const))).flatMap(([commit, files]) => (files ? [[commit, files] as const] : [])));
    return buildRecap(since, threads, mine, me, ai, diffs);
  } catch (error) {
    return { since, reviews: [], comments: [], ai, error: `Couldn't read your earlier comments: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The PR's diff at an earlier head: from the details cache, else GitHub's compare of the base branch with that commit. */
export function filesAt(cached: (repo: string, number: number, sha: string) => PrFile[] | null, compare: SinceDeps["compare"]): RereviewDeps["filesAt"] {
  return async (repo, number, sha, live) => cached(repo, number, sha) ?? (await compare(repo, live.baseRef, sha))?.files ?? null;
}
