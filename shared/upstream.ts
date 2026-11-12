import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const CommentSchema = z.object({
  id: z.string(),
  author: z.string(),
  body: z.string(),
  url: z.string(),
  at: z.string(),
});

export const PrUpstreamSchema = z.object({
  fetchedAt: z.string(),
  headSha: z.string(),
  checks: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      status: z.enum(["failure", "pending", "success", "skipped"]),
      url: z.string().nullable(),
      workflow: z.string().nullable(),
    }),
  ),
  reviews: z.array(CommentSchema.extend({ state: z.string() })),
  comments: z.array(CommentSchema),
  threads: z.array(
    z.object({
      id: z.string(),
      path: z.string(),
      line: z.number().nullable(),
      resolved: z.boolean(),
      outdated: z.boolean(),
      comments: z.array(CommentSchema),
    }),
  ),
});

export type PrUpstream = z.infer<typeof PrUpstreamSchema>;

export const getPrUpstream = defineRpc({
  name: "inbox.pr_upstream",
  input: z.object({ itemKey: z.string() }),
  output: PrUpstreamSchema,
});
