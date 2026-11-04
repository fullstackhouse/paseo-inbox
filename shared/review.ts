import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const MCP_SERVER = "inbox";
export const REVIEW_TOOL = "inbox_review_draft";

export const VerdictSchema = z.enum(["approve", "comment", "request-changes"]);
export type Verdict = z.infer<typeof VerdictSchema>;
export const SeveritySchema = z.enum(["blocker", "major", "minor", "nit"]);

/** What the agent passes to `inbox_review_draft`. */
export const ReviewInputSchema = z.object({
  verdict: VerdictSchema,
  confidence: z.number().int().min(0).max(100),
  summary: z.string().min(1),
  chapters: z
    .array(z.object({ title: z.string().min(1), body: z.string(), files: z.array(z.string()).default([]) }))
    .default([]),
  comments: z
    .array(
      z.object({
        path: z.string().min(1),
        line: z.number().int().min(1),
        side: z.enum(["LEFT", "RIGHT"]).default("RIGHT"),
        severity: SeveritySchema.default("minor"),
        body: z.string().min(1),
      }),
    )
    .default([]),
});
export type ReviewInput = z.infer<typeof ReviewInputSchema>;

export const CommentStatusSchema = z.enum(["draft", "kept", "edited", "dropped"]);

/** A stored draft: one per run, keyed by the PR version it reviewed. */
export const ReviewDraftSchema = ReviewInputSchema.extend({
  runId: z.string(),
  itemKey: z.string(),
  version: z.string(),
  createdAt: z.string(),
  comments: z.array(
    ReviewInputSchema.shape.comments.unwrap().element.extend({ id: z.string(), status: CommentStatusSchema.default("draft") }),
  ),
  postedAt: z.string().optional(),
  postedUrl: z.string().optional(),
});
export type ReviewDraft = z.infer<typeof ReviewDraftSchema>;

export function toDraft(input: ReviewInput, run: { id: string; itemKey: string; version: string }, now: string): ReviewDraft {
  return {
    ...input,
    runId: run.id,
    itemKey: run.itemKey,
    version: run.version,
    createdAt: now,
    comments: input.comments.map((comment, index) => ({ ...comment, id: `c${index + 1}`, status: "draft" as const })),
  };
}

const EVENTS: Record<Verdict, "APPROVE" | "COMMENT" | "REQUEST_CHANGES"> = {
  approve: "APPROVE",
  comment: "COMMENT",
  "request-changes": "REQUEST_CHANGES",
};

/** GitHub's create-review payload: the summary as the body, every comment that isn't dropped inline. */
export function reviewPayload(draft: ReviewDraft) {
  return {
    commit_id: draft.version,
    event: EVENTS[draft.verdict],
    body: draft.summary,
    comments: draft.comments
      .filter((comment) => comment.status !== "dropped")
      .map((comment) => ({ path: comment.path, line: comment.line, side: comment.side, body: comment.body })),
  };
}

/** One line for the inbox card: verdict, confidence, and comment count by severity. */
export function draftHeadline(draft: ReviewDraft): string {
  const live = draft.comments.filter((comment) => comment.status !== "dropped");
  const counts = SeveritySchema.options
    .map((severity) => [severity, live.filter((comment) => comment.severity === severity).length] as const)
    .filter(([, count]) => count)
    .map(([severity, count]) => `${count} ${severity}`);
  return [`${draft.verdict} · ${draft.confidence}%`, counts.length ? counts.join(", ") : "no inline comments"].join(" · ");
}

export const INSTRUCTIONS = `paseo-inbox started you for one pull request. When asked to review it, save your review with ${REVIEW_TOOL} instead of posting it: a verdict, your confidence (0-100), a markdown summary written for someone who hasn't read the diff, optional chapters walking through the change, and inline comments on lines of the PR's diff (RIGHT side = the new code). The human reads, edits and posts it from the Inbox. Calling it again replaces the draft.`;

export const TOOLS = [
  {
    name: REVIEW_TOOL,
    description: "Save your review of this PR as a draft for the human to read and post. Replaces any earlier draft from this run.",
    inputSchema: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: VerdictSchema.options },
        confidence: { type: "integer", minimum: 0, maximum: 100 },
        summary: { type: "string", description: "Markdown. Problem first, then the change, then details." },
        chapters: {
          type: "array",
          items: { type: "object", properties: { title: { type: "string" }, body: { type: "string" }, files: { type: "array", items: { type: "string" } } }, required: ["title", "body"] },
        },
        comments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              line: { type: "integer", description: "Line number in the file, on a line the PR's diff touches" },
              side: { type: "string", enum: ["LEFT", "RIGHT"] },
              severity: { type: "string", enum: SeveritySchema.options },
              body: { type: "string" },
            },
            required: ["path", "line", "body"],
          },
        },
      },
      required: ["verdict", "confidence", "summary"],
    },
  },
];

// ---------- PR details (for the review screen) ----------

export const PrFileSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  status: z.string(),
  additions: z.number(),
  deletions: z.number(),
  /** Absent for binary files and patches GitHub truncates. */
  patch: z.string().optional(),
});
export type PrFile = z.infer<typeof PrFileSchema>;

export const PrDetailsSchema = z.object({
  body: z.string(),
  author: z.string(),
  baseRef: z.string(),
  headRef: z.string(),
  headSha: z.string(),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
  createdAt: z.string(),
  files: z.array(PrFileSchema),
});
export type PrDetails = z.infer<typeof PrDetailsSchema>;

/** Applies a human's keep / edit / drop to one draft comment. */
export function updateComment(draft: ReviewDraft, commentId: string, change: { status: "kept" | "dropped" | "draft" } | { body: string }): ReviewDraft {
  if (draft.postedUrl) throw new Error("Already posted");
  if (!draft.comments.some((comment) => comment.id === commentId)) throw new Error(`No comment ${commentId}`);
  return {
    ...draft,
    comments: draft.comments.map((comment) => {
      if (comment.id !== commentId) return comment;
      if ("body" in change) return { ...comment, body: change.body.trim() || comment.body, status: "edited" as const };
      return { ...comment, status: change.status };
    }),
  };
}

// ---------- RPCs ----------

export const getReview = defineRpc({ name: "inbox.review_get", input: z.object({ runId: z.string() }), output: ReviewDraftSchema.nullable() });
export const getPrDetails = defineRpc({ name: "inbox.pr_get", input: z.object({ itemKey: z.string() }), output: PrDetailsSchema });
export const updateReviewComment = defineRpc({
  name: "inbox.review_comment",
  input: z.object({ runId: z.string(), commentId: z.string(), status: z.enum(["kept", "dropped", "draft"]).optional(), body: z.string().optional() }),
  output: ReviewDraftSchema,
});
export const postReview = defineRpc({ name: "inbox.review_post", input: z.object({ runId: z.string() }), output: z.object({ url: z.string() }) });
