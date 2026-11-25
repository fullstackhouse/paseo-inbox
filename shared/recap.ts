import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { parsePatch } from "./diff";
import { SinceSchema, type MyReview, type Since } from "./rereview";
import { RecapInputSchema, type PrFile, type RecapInput } from "./review";
import type { PrUpstream } from "./upstream";

// ---------- "Since your review": what happened to the human's last review ----------

export type Thread = PrUpstream["threads"][number];

export const ThreadStatusSchema = z.enum(["fixed", "pushed-back", "unanswered", "outdated"]);
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;

const ReplySchema = z.object({ author: z.string(), body: z.string(), at: z.string(), url: z.string() });

export const RecapCommentSchema = z.object({
  thread: z.string(),
  path: z.string(),
  line: z.number().nullable(),
  /** The human's first comment in the thread. */
  body: z.string(),
  url: z.string(),
  at: z.string(),
  status: ThreadStatusSchema,
  /** Why it counts as fixed: the thread was resolved, or the diff since the review changed its lines. */
  why: z.enum(["resolved", "changed"]).optional(),
  /** The last reply from someone else (bots aside). */
  reply: ReplySchema.nullable(),
});
export type RecapComment = z.infer<typeof RecapCommentSchema>;

export const PastReviewSchema = z.object({ id: z.string(), state: z.string(), commit: z.string(), at: z.string(), url: z.string(), comments: z.number() });

export const RecapSchema = z.object({
  since: SinceSchema,
  reviews: z.array(PastReviewSchema),
  comments: z.array(RecapCommentSchema),
  /** The reviewer's verdicts, from the draft (null until it writes them). */
  ai: RecapInputSchema.nullable(),
  /** GitHub couldn't be read: the since diff still shows, the comment statuses don't. */
  error: z.string().optional(),
});
export type Recap = z.infer<typeof RecapSchema>;

const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
const isBot = (login: string) => /\[bot\]$/i.test(login);

/**
 * Whether one side of a patch changes lines `from`..`to`: a removed (old side) or added (new side) line
 * in that range, or a line inserted from just before it to just after it.
 */
function changesLines(patch: string | undefined, side: "old" | "new", from: number, to: number): boolean {
  for (const hunk of parsePatch(patch)) {
    const start = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(hunk.header);
    let next = Number(side === "old" ? start?.[1] : start?.[2]);
    for (const line of hunk.lines) {
      const at = side === "old" ? line.old : line.new;
      const own = side === "old" ? "del" : "add";
      if (at !== undefined) {
        if (line.kind === own && at >= from && at <= to) return true;
        next = at + 1;
      } else if (next >= from && next <= to + 1) return true;
    }
  }
  return false;
}

/** Diffs from a commit to the head (the PR's files only), keyed by that commit: for threads written before the since base. */
export type DiffsFrom = ReadonlyMap<string, readonly PrFile[]>;

function touchedIn(thread: Thread, files: readonly PrFile[], side: "old" | "new"): boolean {
  const file = files.find((candidate) => candidate.path === thread.path || candidate.previousPath === thread.path);
  if (!file) return false;
  if (file.status === "removed") return true;
  if (thread.side === "LEFT") return false;
  if (side === "old" && thread.originalLine != null) return changesLines(file.patch, "old", thread.originalStartLine ?? thread.originalLine, thread.originalLine);
  if (thread.line != null) return changesLines(file.patch, "new", thread.startLine ?? thread.line, thread.line);
  return thread.originalLine == null && !thread.outdated;
}

/**
 * Did the code change on the lines this thread is on since it was written? Read on the old side of the
 * diff from the thread's own commit when that diff is known (`diffs`, or the since diff when the thread
 * was written at its base), else by GitHub's current line on the since diff's new side. A comment on the
 * whole file counts any change to the file. Without a clean diff (rewritten history) nothing counts.
 */
export function touchedSince(thread: Thread, since: Since, diffs: DiffsFrom = new Map()): boolean {
  const own = thread.commit ? diffs.get(thread.commit) : undefined;
  if (own) return touchedIn(thread, own, "old");
  if (since.kind !== "changes") return false;
  return touchedIn(thread, since.files, thread.commit === since.base ? "old" : "new");
}

/** What happened to one of the human's threads, worked out without reading the code. */
export function threadStatus(thread: Thread, me: string, since: Since, diffs?: DiffsFrom): RecapComment {
  const [first, ...rest] = thread.comments;
  const reply = rest.filter((comment) => !same(comment.author, me) && !isBot(comment.author)).at(-1) ?? null;
  const changed = touchedSince(thread, since, diffs);
  const status: ThreadStatus = thread.resolved || changed ? "fixed" : thread.outdated ? "outdated" : reply ? "pushed-back" : "unanswered";
  return {
    thread: thread.id,
    path: thread.path,
    line: thread.line ?? thread.originalLine ?? null,
    body: first?.body ?? "",
    url: first?.url ?? "",
    at: first?.at ?? "",
    status,
    ...(thread.resolved ? { why: "resolved" as const } : changed ? { why: "changed" as const } : {}),
    reply: reply ? { author: reply.author, body: reply.body, at: reply.at, url: reply.url } : null,
  };
}

const ATTENTION: Record<ThreadStatus, number> = { "pushed-back": 0, unanswered: 1, outdated: 2, fixed: 3 };

/** Commits that open threads of the human's were written on, other than the since base: their diffs to the head say whether those changed. */
export function threadCommits(threads: readonly Thread[], me: string, since: Since, max = 5): string[] {
  const base = since.kind === "none" ? null : since.base;
  const commits = threads.filter((thread) => same(thread.comments[0]?.author, me) && !thread.resolved && thread.commit && thread.commit !== base).map((thread) => thread.commit!);
  return [...new Set(commits)].slice(0, max);
}

/** The recap: the human's past reviews (with how many comments each left) and their threads, those needing them first. */
export function buildRecap(since: Since, threads: readonly Thread[], reviews: readonly MyReview[], me: string, ai: RecapInput | null, diffs?: DiffsFrom): Recap {
  if (since.kind === "none") return { since, reviews: [], comments: [], ai: null };
  const written = threads.flatMap((thread) => thread.comments).filter((comment) => same(comment.author, me));
  const past = reviews.map((review) => ({
    id: review.id ?? review.url,
    state: review.state ?? "COMMENTED",
    commit: review.commit,
    at: review.at,
    url: review.url,
    comments: written.filter((comment) => review.id !== undefined && comment.reviewId === review.id).length,
  }));
  const comments = threads
    .filter((thread) => same(thread.comments[0]?.author, me))
    .map((thread) => threadStatus(thread, me, since, diffs))
    .sort((a, b) => ATTENTION[a.status] - ATTENTION[b.status]);
  return { since, reviews: past, comments, ai };
}

export const STATUS_LABEL: Record<ThreadStatus, string> = { fixed: "Fixed", "pushed-back": "Pushed back", unanswered: "Unanswered", outdated: "Outdated" };
export const REVIEW_STATE: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", COMMENTED: "commented", DISMISSED: "dismissed" };
export const ADDRESSED_LABEL: Record<RecapInput["comments"][number]["addressed"], string> = { yes: "Addressed", partly: "Partly addressed", no: "Not addressed" };

/** A comment as one plain line for a list: no grade badge (`⚠️ **minor** — `), emphasis or code ticks. */
export const preview = (body: string) =>
  body
    .replace(/^\s*\S+ \*\*(blocker|minor|major|nit)\*\* — /u, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The reviewer's other changes, logic before mechanical (stable within each). */
export const triage = <T extends { risk: "logic" | "mechanical" }>(changes: readonly T[]): T[] => [...changes].sort((a, b) => (a.risk === b.risk ? 0 : a.risk === "logic" ? -1 : 1));

/** "Check 2 things" or "Full re-look". */
export const lookLabel = (ai: Pick<RecapInput, "look" | "check">) =>
  ai.look === "full" ? "Full re-look" : `Check ${ai.check.length} thing${ai.check.length === 1 ? "" : "s"}`;

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The prior-review section of `inbox_pr`: the human's reviews, their threads by id with statuses, and the diff since. */
export function priorSection(recap: Recap, maxDiff = 60_000): string[] {
  const { since } = recap;
  if (since.kind === "none") return [];
  const base = since.base.slice(0, 7);
  const lines = ["## Your previous review", `The human reviewed this PR before (from ${base}). Fill \`recap\` when you save the draft.`];
  if (recap.reviews.length) {
    lines.push("", "Their reviews, newest first:");
    for (const review of recap.reviews)
      lines.push(`- ${review.at.slice(0, 10)} ${REVIEW_STATE[review.state] ?? review.state.toLowerCase()} on ${review.commit.slice(0, 7)} (${plural(review.comments, "comment")}): ${review.url}`);
  }
  if (recap.comments.length) {
    lines.push("", "Their threads, with a status worked out from GitHub and the diff (check it against the code):");
    for (const comment of recap.comments) {
      const status = comment.status === "fixed" ? `fixed (${comment.why === "resolved" ? "resolved" : "code changed"})` : STATUS_LABEL[comment.status].toLowerCase();
      const reply = comment.reply ? `; last reply @${comment.reply.author}: "${oneLine(comment.reply.body, 300)}"` : "";
      lines.push(`- thread ${comment.thread} · ${comment.path}${comment.line ? `:${comment.line}` : ""} · ${status}: ${oneLine(comment.body, 400)}${reply}`);
    }
  }
  if (since.kind === "same") lines.push("", `No new commits since ${base}.`);
  if (since.kind === "rewritten") lines.push("", `No clean diff since ${base}: the branch was force-pushed or rebased. Set recap.look to "full".`);
  if (since.kind === "changes") {
    lines.push("", `### Diff since ${base} (${plural(since.commits.length, "commit")}, ${plural(since.files.length, "file")})`, ...since.commits.map((commit) => `- ${commit.sha.slice(0, 7)} ${commit.message.split("\n")[0]}`));
    let budget = maxDiff;
    for (const file of since.files) {
      const patch = file.patch ? "```diff\n" + file.patch + "\n```" : "(no patch: binary or too large)";
      const entry = [`#### ${file.status} ${file.path} +${file.additions} −${file.deletions}`, budget - patch.length >= 0 ? patch : "(patch left out: see the full diff below)"];
      budget -= patch.length;
      lines.push("", ...entry);
    }
  }
  return lines;
}

export const reviewRecap = defineRpc({ name: "inbox.review_recap", input: z.object({ runId: z.string() }), output: RecapSchema });
