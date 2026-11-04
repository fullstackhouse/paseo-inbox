import { reviewPayload } from "../shared/review";
import type { Inbox } from "./inbox";
import type { ReviewStore } from "./reviews";

export type Poster = (repo: string, number: number, payload: unknown) => Promise<string>;

/**
 * Posts a run's review draft. Called only from the Inbox screen's button, so a human press is the only
 * way a review reaches GitHub. Refuses a draft whose PR has moved on, or one already posted.
 */
export async function postDraft(inbox: Inbox, reviews: ReviewStore, runId: string, post: Poster, now = new Date().toISOString()): Promise<{ url: string }> {
  const run = inbox.run(runId);
  const draft = reviews.get(runId);
  if (!run || !draft) throw new Error("No review draft for this run");
  if (draft.postedUrl) throw new Error(`Already posted: ${draft.postedUrl}`);
  const item = inbox.item(run.itemKey);
  if (!item) throw new Error("The PR is no longer in any source");
  if (item.pr.headSha !== draft.version) throw new Error(`The PR got new commits since this draft (${draft.version.slice(0, 7)} → ${item.pr.headSha.slice(0, 7)}); rerun to re-draft`);
  const url = await post(item.pr.repo, item.pr.number, reviewPayload(draft));
  reviews.save({ ...draft, postedAt: now, postedUrl: url });
  inbox.markPosted(runId, url);
  return { url };
}
