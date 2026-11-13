import { z } from "zod";
import type { PrUpstream } from "../shared/upstream";
import { gh, type Gh } from "./github";

const Actor = z.object({ login: z.string() }).nullable();
const PageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const connection = <T extends z.ZodType>(node: T) =>
  z.object({ nodes: z.array(node), pageInfo: PageInfo });
const RestComment = z.object({
  id: z.number(),
  user: Actor,
  body: z.string(),
  html_url: z.string(),
  created_at: z.string(),
});
const RestReview = z.object({
  id: z.number(),
  user: Actor,
  body: z.string(),
  html_url: z.string(),
  state: z.string(),
  submitted_at: z.string().nullable(),
});
const ThreadComment = z.object({
  id: z.string(),
  author: Actor,
  body: z.string(),
  url: z.string(),
  createdAt: z.string(),
  pullRequestReview: z.object({ state: z.string(), databaseId: z.number().nullable() }).nullable(),
});
const Thread = z.object({
  id: z.string(),
  path: z.string(),
  line: z.number().nullable(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  comments: connection(ThreadComment),
});
const Check = z.discriminatedUnion("__typename", [
  z.object({
    __typename: z.literal("CheckRun"),
    id: z.string(),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    detailsUrl: z.string().nullable(),
    checkSuite: z
      .object({ workflowRun: z.object({ workflow: z.object({ name: z.string() }) }).nullable() })
      .nullable(),
  }),
  z.object({
    __typename: z.literal("StatusContext"),
    id: z.string(),
    context: z.string(),
    state: z.string(),
    targetUrl: z.string().nullable(),
  }),
]);

const CHECKS_QUERY = `query InboxChecks($owner: String!, $name: String!, $sha: GitObjectID!, $cursor: String) {
  repository(owner: $owner, name: $name) { object(oid: $sha) { ... on Commit {
    statusCheckRollup { contexts(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { __typename
        ... on CheckRun { id name status conclusion detailsUrl checkSuite { workflowRun { workflow { name } } } }
        ... on StatusContext { id context state targetUrl }
      }
    } }
  } } }
}`;
const COMMENT_FIELDS =
  "id author { login } body url createdAt pullRequestReview { state databaseId }";
const THREADS_QUERY = `query InboxThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewThreads(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id path line isResolved isOutdated
        comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} } }
      }
    }
  } }
}`;
const COMMENTS_QUERY = `query InboxThreadComments($id: ID!, $cursor: String) {
  node(id: $id) { ... on PullRequestReviewThread {
    comments(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} } }
  } }
}`;

async function graphql(
  run: Gh,
  query: string,
  variables: Record<string, string | number>,
): Promise<unknown> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables))
    args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
  const response: unknown = JSON.parse(await run(args));
  const errors = z
    .object({ errors: z.array(z.object({ message: z.string() })).optional() })
    .parse(response).errors;
  if (errors?.length) throw new Error(errors.map((error) => error.message).join("; "));
  return response;
}

async function allPages<T>(
  read: (cursor?: string) => Promise<{ nodes: T[]; pageInfo: z.infer<typeof PageInfo> }>,
): Promise<T[]> {
  const nodes: T[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (;;) {
    const page = await read(cursor);
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return nodes;
    const next = page.pageInfo.endCursor;
    if (!next || seen.has(next)) throw new Error("GitHub returned an invalid pagination cursor");
    seen.add(next);
    cursor = next;
  }
}

function toCheck(check: z.infer<typeof Check>): PrUpstream["checks"][number] {
  if (check.__typename === "StatusContext") {
    return {
      id: check.id,
      name: check.context,
      status:
        check.state === "SUCCESS"
          ? "success"
          : ["FAILURE", "ERROR"].includes(check.state)
            ? "failure"
            : "pending",
      url: check.targetUrl,
      workflow: null,
    };
  }
  const status =
    check.status !== "COMPLETED" || !check.conclusion
      ? "pending"
      : check.conclusion === "SUCCESS"
        ? "success"
        : ["SKIPPED", "NEUTRAL"].includes(check.conclusion)
          ? "skipped"
          : "failure";
  return {
    id: check.id,
    name: check.name,
    status,
    url: check.detailsUrl,
    workflow: check.checkSuite?.workflowRun?.workflow.name ?? null,
  };
}

async function checksFor(repo: string, sha: string, run: Gh): Promise<PrUpstream["checks"]> {
  const [owner, name] = repo.split("/");
  const schema = z.object({
    data: z.object({
      repository: z.object({
        object: z.object({
          statusCheckRollup: z.object({ contexts: connection(Check) }).nullable(),
        }),
      }),
    }),
  });
  const checks = await allPages(async (cursor) => {
    const value = schema.parse(
      await graphql(run, CHECKS_QUERY, { owner, name, sha, ...(cursor ? { cursor } : {}) }),
    );
    return (
      value.data.repository.object.statusCheckRollup?.contexts ?? {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      }
    );
  });
  return checks.map(toCheck);
}

async function threadsFor(repo: string, number: number, run: Gh): Promise<PrUpstream["threads"]> {
  const [owner, name] = repo.split("/");
  const schema = z.object({
    data: z.object({
      repository: z.object({ pullRequest: z.object({ reviewThreads: connection(Thread) }) }),
    }),
  });
  const threads = await allPages(
    async (cursor) =>
      schema.parse(
        await graphql(run, THREADS_QUERY, { owner, name, number, ...(cursor ? { cursor } : {}) }),
      ).data.repository.pullRequest.reviewThreads,
  );
  const result: PrUpstream["threads"] = [];
  // Fetch long discussions sequentially rather than starting one request per thread at once.
  for (const thread of threads) {
    const comments = await allPages(async (cursor) => {
      if (!cursor) return thread.comments;
      return z
        .object({ data: z.object({ node: z.object({ comments: connection(ThreadComment) }) }) })
        .parse(await graphql(run, COMMENTS_QUERY, { id: thread.id, cursor })).data.node.comments;
    });
    const published = comments
      .filter((comment) => comment.pullRequestReview?.state !== "PENDING")
      .map((comment) => ({
        id: comment.id,
        author: comment.author?.login ?? "Deleted user",
        body: comment.body,
        url: comment.url,
        at: comment.createdAt,
        reviewId:
          comment.pullRequestReview?.databaseId == null
            ? null
            : String(comment.pullRequestReview.databaseId),
      }));
    if (published.length)
      result.push({
        id: thread.id,
        path: thread.path,
        line: thread.line,
        resolved: thread.isResolved,
        outdated: thread.isOutdated,
        comments: published,
      });
  }
  return result;
}

/** Current published GitHub data; comments and checks can change without a new commit. */
export async function fetchPrUpstream(
  repo: string,
  number: number,
  run: Gh = gh,
): Promise<PrUpstream> {
  const {
    headRefOid: headSha,
    state,
    isDraft,
  } = z
    .object({
      headRefOid: z.string(),
      state: z.enum(["OPEN", "CLOSED", "MERGED"]),
      isDraft: z.boolean(),
    })
    .parse(
      JSON.parse(
        await run([
          "pr",
          "view",
          String(number),
          "--repo",
          repo,
          "--json",
          "headRefOid,state,isDraft",
        ]),
      ),
    );
  const [checks, threads, reviewPages, commentPages] = await Promise.all([
    checksFor(repo, headSha, run),
    threadsFor(repo, number, run),
    run(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${number}/reviews?per_page=100`]),
    run(["api", "--paginate", "--slurp", `repos/${repo}/issues/${number}/comments?per_page=100`]),
  ]);
  return {
    fetchedAt: new Date().toISOString(),
    headSha,
    state:
      state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : isDraft ? "draft" : "open",
    checks,
    threads,
    reviews: z
      .array(z.array(RestReview))
      .parse(JSON.parse(reviewPages))
      .flat()
      .flatMap((review) =>
        review.state === "PENDING" || !review.submitted_at
          ? []
          : [
              {
                id: String(review.id),
                author: review.user?.login ?? "Deleted user",
                state: review.state,
                body: review.body,
                url: review.html_url,
                at: review.submitted_at,
              },
            ],
      ),
    comments: z
      .array(z.array(RestComment))
      .parse(JSON.parse(commentPages))
      .flat()
      .map((comment) => ({
        id: String(comment.id),
        author: comment.user?.login ?? "Deleted user",
        body: comment.body,
        url: comment.html_url,
        at: comment.created_at,
      })),
  };
}
