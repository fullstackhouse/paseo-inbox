import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { parsePatch } from "./diff";
import { PrFileSchema, type Anchor, type PrFile, type ReviewDraft, type StoredComment } from "./review";

// ---------- Comments following the code (Cerber §13.3) ----------

const CONTEXT = 3;
type Side = "LEFT" | "RIGHT";
type Lines = Map<number, string>;

/** Line number → text for each side of one file's patch: new side = added + context, old side = deleted + context. */
export function sideLines(patch: string | undefined): Record<Side, Lines> {
  const sides: Record<Side, Lines> = { LEFT: new Map(), RIGHT: new Map() };
  for (const hunk of parsePatch(patch)) {
    for (const line of hunk.lines) {
      if (line.new !== undefined) sides.RIGHT.set(line.new, line.text);
      if (line.old !== undefined) sides.LEFT.set(line.old, line.text);
    }
  }
  return sides;
}

export function anchorAt(lines: Lines, line: number, version: string): Anchor | null {
  const text = lines.get(line);
  if (text === undefined) return null;
  const around = (step: number) => Array.from({ length: CONTEXT }, (_, index) => lines.get(line + step * (index + 1)) ?? null);
  return { text, above: around(-1), below: around(1), version };
}

/**
 * Where an anchor sits in a new patch, or null (drifted). Exact text only: the same line number if its
 * text is unchanged, else the one line with that text, else the one whose neighbours agree. A neighbour
 * missing on either side is neutral; any neighbour that differs rules the candidate out.
 */
export function locate(anchor: Anchor, lines: Lines, preferred: number): number | null {
  if (lines.get(preferred) === anchor.text) return preferred;
  const candidates = [...lines].filter(([, text]) => text === anchor.text).map(([number]) => number);
  if (candidates.length <= 1) return candidates[0] ?? null;
  const fits = (number: number) =>
    [-1, 1].every((step) =>
      (step < 0 ? anchor.above : anchor.below).every((want, index) => {
        const have = lines.get(number + step * (index + 1));
        return want === null || have === undefined || have === want;
      }),
    );
  const survivors = candidates.filter(fits);
  return survivors.length === 1 ? survivors[0]! : null;
}

export interface Reanchored {
  draft: ReviewDraft;
  moved: number;
  drifted: number;
  unchanged: number;
}

/**
 * Carries a draft to a new head without an AI run. Each line comment is found again by its text in the
 * new diff; one that can't be found is marked drifted and goes into the review body. Every decision the
 * human made (keep, edit, drop, grade, reply) stays as it was. Summary, chapters and verdict are left as
 * written: `reviewedVersion` records the commit they describe.
 */
export function reanchorDraft(draft: ReviewDraft, oldFiles: readonly PrFile[] | null, newFiles: readonly PrFile[], to: { version: string; runId: string }, now: string): Reanchored {
  if (draft.postedUrl) throw new Error(`Already posted: ${draft.postedUrl}`);
  const oldSides = new Map((oldFiles ?? []).map((file) => [file.path, sideLines(file.patch)]));
  const newByPath = new Map(newFiles.map((file) => [file.path, file]));
  // A file renamed by the new commits is found under its new name.
  const renamed = new Map(newFiles.filter((file) => file.previousPath).map((file) => [file.previousPath!, file]));
  const newSides = new Map<string, Record<Side, Lines>>();
  const sidesOf = (file: PrFile) => newSides.get(file.path) ?? newSides.set(file.path, sideLines(file.patch)).get(file.path)!;
  let moved = 0;
  let drifted = 0;
  let unchanged = 0;

  const comments = draft.comments.map((comment): StoredComment => {
    if (comment.line === null) {
      unchanged++;
      return comment;
    }
    const anchor = comment.anchor ?? anchorAt(oldSides.get(comment.path)?.[comment.side] ?? new Map(), comment.line, draft.version);
    const file = newByPath.get(comment.path) ?? renamed.get(comment.path);
    const found = anchor && file ? locate(anchor, sidesOf(file)[comment.side], comment.line) : null;
    const base = { ...comment, anchor: anchor ?? comment.anchor, originalLine: comment.originalLine ?? comment.line };
    if (found === null) {
      drifted++;
      // The stale line stays: with the anchor, it's the only trace of what the comment pointed at.
      return { ...base, drifted: true };
    }
    if (found === comment.line && file!.path === comment.path && !comment.drifted) unchanged++;
    else moved++;
    return { ...base, path: file!.path, line: found, drifted: false };
  });

  return {
    draft: {
      ...draft,
      runId: to.runId,
      version: to.version,
      reviewedVersion: draft.reviewedVersion ?? draft.version,
      reanchored: { from: draft.version, at: now, moved, drifted },
      comments,
    },
    moved,
    drifted,
    unchanged,
  };
}

// ---------- Changes since my last review ----------

/** The human's latest review of this PR on GitHub. */
export type MyReview = { commit: string; at: string; url: string };

export type SinceBase = { sha: string; from: "draft" | "reviewed" | "posted"; at?: string };

/**
 * The commit the human last reviewed, if it isn't the head: the commit a stale draft was written for,
 * the one a re-anchored draft's summary describes, or the commit of their latest review on GitHub.
 */
export function sinceBase(draft: Pick<ReviewDraft, "version" | "reviewedVersion"> | null, head: string, mine: MyReview | null): SinceBase | null {
  if (draft && draft.version !== head) return { sha: draft.version, from: "draft" };
  if (draft?.reviewedVersion && draft.reviewedVersion !== head) return { sha: draft.reviewedVersion, from: "reviewed" };
  // At the head too: "no new commits since your review" is worth saying when you're asked again.
  return mine ? { sha: mine.commit, from: "posted", at: mine.at } : null;
}

/** GitHub's compare of base...head, as the server reads it; null when base is gone (force-pushed away). */
export type Compare = { status: string; behindBy: number; commits: { sha: string; message: string }[]; files: PrFile[] };

export const SinceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("same"), base: z.string(), from: z.enum(["draft", "reviewed", "posted"]), at: z.string().optional() }),
  z.object({ kind: z.literal("rewritten"), base: z.string(), from: z.enum(["draft", "reviewed", "posted"]), at: z.string().optional(), why: z.enum(["unreachable", "diverged"]) }),
  z.object({
    kind: z.literal("changes"),
    base: z.string(),
    head: z.string(),
    from: z.enum(["draft", "reviewed", "posted"]),
    at: z.string().optional(),
    commits: z.array(z.object({ sha: z.string(), message: z.string() })),
    files: z.array(PrFileSchema),
    /** Files the compare shows that aren't in the PR: the base branch merged in. */
    hidden: z.number(),
  }),
]);
export type Since = z.infer<typeof SinceSchema>;

/**
 * What a re-review reads. A base GitHub can't reach, or history that no longer contains it (a force-push
 * or rebase), has no clean "since" diff, so the screen says so and points at the full diff. Files the
 * PR doesn't change are left out: they came from merging the base branch in.
 */
export function sinceChanges(base: SinceBase | null, head: string, compare: Compare | null, prPaths: ReadonlySet<string>): Since {
  if (!base) return { kind: "none" };
  const about = { base: base.sha, from: base.from, ...(base.at ? { at: base.at } : {}) };
  if (base.sha === head) return { kind: "same", ...about };
  if (!compare) return { kind: "rewritten", ...about, why: "unreachable" };
  if (compare.status === "identical") return { kind: "same", ...about };
  if (compare.status === "diverged" || compare.status === "behind" || compare.behindBy > 0) return { kind: "rewritten", ...about, why: "diverged" };
  const files = compare.files.filter((file) => prPaths.has(file.path));
  return { kind: "changes", ...about, head, commits: compare.commits, files, hidden: compare.files.length - files.length };
}

// ---------- Asked again ----------

/** A review request on the PR's timeline; `reviewer` is null for a team. */
export type ReviewRequest = { at: string; reviewer: string | null; by: string };

/**
 * The newest request naming `me` made after `since` (when the human settled the run), or null.
 * Team requests don't count: reopening undoes the human's decision, so only being named does.
 */
export function askedAgain(requests: readonly ReviewRequest[], me: string, since: string): ReviewRequest | null {
  const settled = Date.parse(since);
  const mine = requests.filter((request) => request.reviewer?.toLowerCase() === me.toLowerCase() && Date.parse(request.at) > settled);
  return mine.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
}

// ---------- RPCs ----------

export const reanchorReview = defineRpc({
  name: "inbox.review_reanchor",
  input: z.object({ runId: z.string() }),
  output: z.object({ runId: z.string(), moved: z.number(), drifted: z.number(), unchanged: z.number() }),
});
export const reviewSince = defineRpc({ name: "inbox.review_since", input: z.object({ runId: z.string() }), output: SinceSchema });
