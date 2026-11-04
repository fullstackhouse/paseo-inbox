import { composeReview, effectiveVerdict, type PrDetails } from "../shared/review";
import type { Inbox } from "./inbox";
import type { ReviewStore } from "./reviews";

export type Poster = (repo: string, number: number, payload: unknown) => Promise<string>;
export type Details = (repo: string, number: number) => Promise<PrDetails>;
/** `gh api` with a JSON body on stdin; returns stdout. */
export type GhJson = (args: string[], body: unknown) => Promise<string>;

function context(inbox: Inbox, reviews: ReviewStore, runId: string) {
  const run = inbox.run(runId);
  const draft = reviews.get(runId);
  if (!run || !draft) throw new Error("No review draft for this run");
  if (draft.postedUrl) throw new Error(`Already posted: ${draft.postedUrl}`);
  const item = inbox.item(run.itemKey);
  if (!item) throw new Error("The PR is no longer in any source");
  return { run, draft, pr: item.pr };
}

/** Exactly what Post would send, against GitHub's live head and diff. */
export async function previewDraft(inbox: Inbox, reviews: ReviewStore, runId: string, details: Details) {
  const run = inbox.run(runId);
  const draft = reviews.get(runId);
  const item = run ? inbox.item(run.itemKey) : null;
  if (!run || !draft || !item) throw new Error("No review draft for this run");
  const live = await details(item.pr.repo, item.pr.number);
  const composed = composeReview(draft, live.files);
  return {
    event: composed.payload.event,
    body: composed.payload.body,
    generatedBody: composed.generatedBody,
    edited: draft.bodyOverride !== undefined,
    comments: composed.payload.comments.map(({ path, line, body }) => ({ path, line, body })),
    replies: composed.replies,
    folded: composed.folded,
    held: composed.held,
  };
}

/**
 * Posts a run's review draft. Called only from the review screen's button, so a human press is the
 * only way a review reaches GitHub. Checks GitHub's live head (not the last poll), refuses a draft the
 * PR has moved past or one already posted, folds comments that can't go inline into the body, and
 * posts already-raised findings the human chose to reply with as replies in their threads.
 */
export async function postDraft(inbox: Inbox, reviews: ReviewStore, runId: string, post: Poster, details: Details, now = new Date().toISOString(), ghJson?: GhJson) {
  const { draft, pr } = context(inbox, reviews, runId);
  const live = await details(pr.repo, pr.number);
  if (live.headSha !== draft.version) throw new Error(`The PR got new commits since this draft (${draft.version.slice(0, 7)} → ${live.headSha.slice(0, 7)}); re-draft it`);
  const { payload, inline, folded, replies } = composeReview(draft, live.files);
  const url = await post(pr.repo, pr.number, payload);
  reviews.save({ ...draft, postedAt: now, postedUrl: url, postedVerdict: effectiveVerdict(draft) });
  inbox.markPosted(runId, url);
  const failed: number[] = [];
  for (const reply of replies) {
    try {
      await ghJson?.(["api", "--method", "POST", `repos/${pr.repo}/pulls/${pr.number}/comments/${reply.commentId}/replies`, "--input", "-"], { body: reply.body });
    } catch {
      failed.push(reply.commentId);
    }
  }
  return { url, inline, folded, replies: replies.length - failed.length, failedReplies: failed.length };
}

/**
 * Hands the review request to someone else: requests their review, withdraws yours, and leaves a note
 * that names them; with sendDraft the note carries your draft as a COMMENT review (never an approval
 * or a request for changes, which would speak for them).
 */
export async function handoffDraft(
  inbox: Inbox,
  reviews: ReviewStore,
  runId: string,
  input: { to: string; note: string; sendDraft: boolean },
  deps: { details: Details; ghJson: GhJson; me: () => Promise<string>; post: Poster },
  now = new Date().toISOString(),
) {
  const run = inbox.run(runId);
  const item = run ? inbox.item(run.itemKey) : null;
  if (!run || !item) throw new Error("Unknown run");
  const draft = reviews.get(runId);
  if (draft?.postedUrl) throw new Error(`Already posted: ${draft.postedUrl}`);
  const { repo, number } = item.pr;
  const to = input.to.replace(/^@/, "");
  const me = await deps.me().catch(() => "");
  if (to.toLowerCase() === me.toLowerCase()) throw new Error("That's you");
  await deps.ghJson(["api", "--method", "POST", `repos/${repo}/pulls/${number}/requested_reviewers`, "--input", "-"], { reviewers: [to] });
  if (me) await deps.ghJson(["api", "--method", "DELETE", `repos/${repo}/pulls/${number}/requested_reviewers`, "--input", "-"], { reviewers: [me] }).catch(() => "");
  const note = [`@${to}, I'm handing this review to you.`, input.note.trim()].filter(Boolean).join(" ");
  let url: string;
  if (input.sendDraft && draft) {
    const live = await deps.details(repo, number);
    const { payload } = composeReview({ ...draft, verdictOverride: "comment" }, live.files);
    const sameHead = live.headSha === draft.version;
    url = await deps.post(repo, number, {
      ...(sameHead ? payload : { ...payload, comments: [] }),
      event: "COMMENT",
      body: `${note}\n\nMy draft so far${sameHead ? "" : ` (written at ${draft.version.slice(0, 7)}; inline comments left out because the PR moved on)`}:\n\n${payload.body}`,
    });
  } else {
    const out = await deps.ghJson(["api", "--method", "POST", `repos/${repo}/issues/${number}/comments`, "--input", "-"], { body: note });
    url = (JSON.parse(out) as { html_url?: string }).html_url ?? item.pr.url;
  }
  inbox.markHandedOff(runId, to, url);
  if (draft) reviews.save({ ...draft, postedAt: now, postedUrl: url, postedVerdict: input.sendDraft ? "comment" : undefined });
  return { url };
}
