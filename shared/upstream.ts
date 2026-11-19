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
  state: z.enum(["open", "draft", "merged", "closed"]),
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
      comments: z.array(CommentSchema.extend({ reviewId: z.string().nullable() })),
    }),
  ),
});

export type PrUpstream = z.infer<typeof PrUpstreamSchema>;

export const getPrUpstream = defineRpc({
  name: "inbox.pr_upstream",
  input: z.object({ itemKey: z.string() }),
  output: PrUpstreamSchema,
});
/** The same, for a PR read by link (URL or owner/repo#n) that isn't in the inbox. */
export const previewPrUpstream = defineRpc({
  name: "inbox.pr_upstream_preview",
  input: z.object({ ref: z.string().min(1) }),
  output: PrUpstreamSchema,
});

/** One GitHub deployment on the PR's head commit; `url` is the first environment URL among its statuses. */
export type Deployment = {
  environment: string;
  createdAt: string;
  state: string | null;
  logUrl: string | null;
  url: string | null;
};

export const DeployEntrySchema = z.object({
  state: z.enum(["ready", "deploying", "failed", "inactive"]),
  label: z.string(),
  link: z.string().nullable(),
});
export type DeployEntry = z.infer<typeof DeployEntrySchema>;

const deployState = (state: string | null): DeployEntry["state"] | null =>
  state === "SUCCESS"
    ? "ready"
    : state && ["IN_PROGRESS", "QUEUED", "PENDING", "WAITING"].includes(state)
      ? "deploying"
      : state === "FAILURE" || state === "ERROR"
        ? "failed"
        : state === "INACTIVE" || state === null
          ? "inactive"
          : null;

const hostOf = (url: string) => /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url)?.[1] ?? url;

/**
 * Preview links for the header: one entry per URL (its newest deployment wins), labelled by host.
 * Inactive ones show only when nothing else does. Deployments without a URL (teardowns, a CD job that
 * doesn't report one) show as a single "deploying" entry while any of them runs, else not at all.
 */
export function deployEntries(deployments: Deployment[]): DeployEntry[] {
  const newest = [...deployments].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const byUrl = new Map<string, Deployment>();
  for (const deployment of newest)
    if (deployment.url && !byUrl.has(deployment.url)) byUrl.set(deployment.url, deployment);
  const entries: DeployEntry[] = [];
  for (const [url, deployment] of byUrl) {
    const state = deployState(deployment.state);
    if (!state) continue;
    const link = state === "ready" || state === "inactive" ? url : (deployment.logUrl ?? url);
    entries.push({ state, label: hostOf(url), link });
  }
  const running = newest.find((deployment) => !deployment.url && deployState(deployment.state) === "deploying");
  if (running) entries.push({ state: "deploying", label: running.environment, link: running.logUrl });
  const live = entries.filter((entry) => entry.state !== "inactive");
  return (live.length ? live : entries).sort((a, b) => a.label.localeCompare(b.label));
}

export const getPrDeployments = defineRpc({
  name: "inbox.pr_deployments",
  input: z.object({ itemKey: z.string() }),
  output: z.array(DeployEntrySchema),
});
/** The same, for a PR read by link. */
export const previewPrDeployments = defineRpc({
  name: "inbox.pr_deployments_preview",
  input: z.object({ ref: z.string().min(1) }),
  output: z.array(DeployEntrySchema),
});

/** Poll interval for the header's deployments: 30s while one is deploying, otherwise none. */
export const deployRefetch = (entries: DeployEntry[] | undefined): number | false =>
  entries?.some((entry) => entry.state === "deploying") ? 30_000 : false;
