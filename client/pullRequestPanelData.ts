import type { PullRequestPanelData } from "./pull-request-host";
import type { Pr } from "../shared/inbox";
import type { PrUpstream } from "../shared/upstream";

/** Keep GitHub transport details out of the host's shared PR presentation. */
export function pullRequestPanelData(
  pr: Pick<Pr, "number" | "title" | "url" | "repo">,
  data: PrUpstream,
): PullRequestPanelData {
  const [repoOwner, repoName] = pr.repo.split("/");
  return {
    forge: "github",
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: data.state,
    repoOwner,
    repoName,
    checks: data.checks.map((check) => ({
      name: check.name,
      status: check.status,
      url: check.url ?? "",
      workflow: check.workflow ?? undefined,
    })),
    activity: [
      ...data.comments.map((comment) => ({
        id: `comment:${comment.id}`,
        kind: "comment" as const,
        author: comment.author,
        body: comment.body,
        url: comment.url,
        createdAt: comment.at,
      })),
      ...data.reviews.map((review) => ({
        id: review.id,
        kind: "review" as const,
        author: review.author,
        body: review.body,
        url: review.url,
        createdAt: review.at,
        reviewId: review.id,
        reviewState:
          review.state === "APPROVED"
            ? ("approved" as const)
            : review.state === "CHANGES_REQUESTED"
              ? ("changes_requested" as const)
              : review.state === "COMMENTED"
                ? ("commented" as const)
                : undefined,
      })),
      ...data.threads.flatMap((thread) =>
        thread.comments.map((comment) => ({
          id: `thread-comment:${comment.id}`,
          kind: "comment" as const,
          author: comment.author,
          body: comment.body,
          url: comment.url,
          createdAt: comment.at,
          reviewId: comment.reviewId ?? undefined,
          threadId: thread.id,
          threadIsResolved: thread.resolved,
          location: {
            path: thread.path,
            line: thread.line ?? undefined,
            threadId: thread.id,
            isResolved: thread.resolved,
            isOutdated: thread.outdated,
          },
        })),
      ),
    ],
  };
}
