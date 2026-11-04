import { composeReview, effectiveVerdict, type PrDetails } from "../shared/review";
import type { Inbox } from "./inbox";
import type { ReviewStore } from "./reviews";

export type Poster = (repo: string, number: number, payload: unknown) => Promise<string>;
export type Details = (repo: string, number: number) => Promise<PrDetails>;

/**
 * Posts a run's review draft. Called only from the review screen's button, so a human press is the
 * only way a review reaches GitHub. Checks GitHub's live head (not the last poll), refuses a draft the
 * PR has moved past or one already posted, and folds comments that can't go inline into the body.
 */
export async function postDraft(inbox: Inbox, reviews: ReviewStore, runId: string, post: Poster, details: Details, now = new Date().toISOString()) {
  const run = inbox.run(runId);
  const draft = reviews.get(runId);
  if (!run || !draft) throw new Error("No review draft for this run");
  if (draft.postedUrl) throw new Error(`Already posted: ${draft.postedUrl}`);
  const item = inbox.item(run.itemKey);
  if (!item) throw new Error("The PR is no longer in any source");
  const live = await details(item.pr.repo, item.pr.number);
  if (live.headSha !== draft.version) throw new Error(`The PR got new commits since this draft (${draft.version.slice(0, 7)} → ${live.headSha.slice(0, 7)}); re-draft it`);
  const { payload, inline, folded } = composeReview(draft, live.files);
  const url = await post(item.pr.repo, item.pr.number, payload);
  reviews.save({ ...draft, postedAt: now, postedUrl: url, postedVerdict: effectiveVerdict(draft) });
  inbox.markPosted(runId, url);
  return { url, inline, folded };
}
