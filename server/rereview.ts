import { runId as makeRunId } from "../shared/inbox";
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
}

/** "Changes since my last review" for a run's PR: what changed between the commit the human last reviewed and the live head. */
export async function sinceRun(inbox: Inbox, reviews: ReviewStore, runId: string, deps: SinceDeps): Promise<Since> {
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
  const compare = base && base.sha !== live.headSha ? await deps.compare(item.pr.repo, base.sha, live.headSha) : null;
  return sinceChanges(base, live.headSha, compare, new Set(live.files.map((file) => file.path)));
}

/** The PR's diff at an earlier head: from the details cache, else GitHub's compare of the base branch with that commit. */
export function filesAt(cached: (repo: string, number: number, sha: string) => PrFile[] | null, compare: SinceDeps["compare"]): RereviewDeps["filesAt"] {
  return async (repo, number, sha, live) => cached(repo, number, sha) ?? (await compare(repo, live.baseRef, sha))?.files ?? null;
}
