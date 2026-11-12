import { describe, expect, it, vi } from "vitest";
import { GithubSource, PrDetailsCache, queryArgs, summarizeChecks } from "../server/github";

import { fetchPrUpstream } from "../server/upstream";
import { PrUpstreamSchema } from "../shared/upstream";
import { pullRequestPanelData } from "../client/pullRequestPanelData";

describe("summarizeChecks", () => {
  it("prefers failing, then pending, then passing", () => {
    expect(summarizeChecks([])).toBe("none");
    expect(
      summarizeChecks([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "COMPLETED", conclusion: "SKIPPED" },
      ]),
    ).toBe("passing");
    expect(
      summarizeChecks([
        { status: "IN_PROGRESS", conclusion: null },
        { status: "COMPLETED", conclusion: "SUCCESS" },
      ]),
    ).toBe("pending");
    expect(
      summarizeChecks([{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "FAILURE" }]),
    ).toBe("failing");
    expect(summarizeChecks([{ state: "ERROR" }])).toBe("failing");
    expect(summarizeChecks([{ state: "PENDING" }])).toBe("pending");
  });
});

describe("fetchPrUpstream", () => {
  const page = <T>(nodes: T[], cursor: string | null = null) => ({
    nodes,
    pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
  });
  const comment = (id: number) => ({
    id,
    user: { login: "ola" },
    body: `Comment ${id}`,
    html_url: `https://github.com/acme/shop/pull/7#${id}`,
    created_at: "2026-11-12T10:00:00Z",
  });
  const threadComment = (id: string, state = "COMMENTED") => ({
    id,
    author: { login: "ola" },
    body: id,
    url: `https://github.com/acme/shop/pull/7#${id}`,
    createdAt: "2026-11-12T10:00:00Z",
    pullRequestReview: { state, databaseId: 123 },
  });
  const thread = (id: string, comments = page([threadComment(id)])) => ({
    id,
    path: "file.ts",
    line: 4,
    isResolved: false,
    isOutdated: false,
    comments,
  });
  const check = (id: string, conclusion: string | null, status = "COMPLETED") => ({
    __typename: "CheckRun",
    id,
    name: id,
    status,
    conclusion,
    detailsUrl: `https://github.com/check/${id}`,
    checkSuite: { workflowRun: { workflow: { name: "CI" } } },
  });
  const context = (state: string) => ({
    __typename: "StatusContext",
    id: state,
    context: state,
    state,
    targetUrl: null,
  });
  const empty = async (args: string[]) => {
    if (args[0] === "pr")
      return JSON.stringify({ headRefOid: "abc", state: "OPEN", isDraft: false });
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    if (query.includes("InboxChecks"))
      return JSON.stringify({
        data: { repository: { object: { statusCheckRollup: { contexts: page([]) } } } },
      });
    if (query.includes("InboxThreads"))
      return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: page([]) } } } });
    return "[[]]";
  };

  it("paginates checks, published reviews and bot comments and normalizes check states", async () => {
    const run = vi.fn(async (args: string[]) => {
      const query = args.find((arg) => arg.startsWith("query=")) ?? "";
      if (query.includes("InboxChecks"))
        return JSON.stringify({
          data: {
            repository: {
              object: {
                statusCheckRollup: {
                  contexts: args.includes("cursor=checks-2")
                    ? page([
                        context("SUCCESS"),
                        context("FAILURE"),
                        context("ERROR"),
                        context("PENDING"),
                        context("EXPECTED"),
                      ])
                    : page(
                        [
                          check("ok", "SUCCESS"),
                          check("failed", "FAILURE"),
                          check("running", null, "IN_PROGRESS"),
                          check("skipped", "SKIPPED"),
                          check("neutral", "NEUTRAL"),
                          check("cancelled", "CANCELLED"),
                          check("timeout", "TIMED_OUT"),
                          check("action", "ACTION_REQUIRED"),
                        ],
                        "checks-2",
                      ),
                },
              },
            },
          },
        });
      if (args.some((arg) => arg.includes("/reviews?")))
        return JSON.stringify([
          [
            { ...comment(1), state: "APPROVED", submitted_at: "2026-11-12T10:00:00Z" },
            { ...comment(2), state: "PENDING", submitted_at: null },
          ],
          [{ ...comment(3), state: "CHANGES_REQUESTED", submitted_at: "2026-11-12T11:00:00Z" }],
        ]);
      if (args.some((arg) => arg.includes("/issues/")))
        return JSON.stringify([
          [{ ...comment(4), user: { login: "github-actions[bot]" } }],
          [{ ...comment(5), user: null }],
        ]);
      return empty(args);
    });
    const result = await fetchPrUpstream("acme/shop", 7, run);
    expect(PrUpstreamSchema.safeParse(result).success).toBe(true);
    expect(result.checks.map((item) => item.status)).toEqual([
      "success",
      "failure",
      "pending",
      "skipped",
      "skipped",
      "failure",
      "failure",
      "failure",
      "success",
      "failure",
      "failure",
      "pending",
      "pending",
    ]);
    expect(result.checks[0]?.workflow).toBe("CI");
    expect(result.reviews.map((review) => review.id)).toEqual(["1", "3"]);
    expect(result.comments.map((item) => item.author)).toEqual([
      "github-actions[bot]",
      "Deleted user",
    ]);
    expect(
      run.mock.calls
        .filter(([args]) =>
          args.some((arg) => arg.includes("/reviews?") || arg.includes("/issues/")),
        )
        .every(([args]) => args.includes("--paginate") && args.includes("--slurp")),
    ).toBe(true);
    expect(
      run.mock.calls
        .filter(([args]) => args.some((arg) => arg.includes("InboxChecks")))
        .every(([args]) => args.includes("sha=abc")),
    ).toBe(true);
  });

  it("paginates threads and long discussions, omitting private drafts", async () => {
    const run = vi.fn(async (args: string[]) => {
      const query = args.find((arg) => arg.startsWith("query=")) ?? "";
      if (query.includes("InboxThreads"))
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: args.includes("cursor=threads-2")
                  ? page([
                      { ...thread("resolved"), isResolved: true, isOutdated: true, line: null },
                      thread("private", page([threadComment("private", "PENDING")])),
                    ])
                  : page(
                      [thread("long", page([threadComment("first")], "comments-2"))],
                      "threads-2",
                    ),
              },
            },
          },
        });
      if (query.includes("InboxThreadComments")) {
        expect(args).toContain("id=long");
        expect(args).toContain("cursor=comments-2");
        return JSON.stringify({
          data: {
            node: { comments: page([threadComment("second"), threadComment("draft", "PENDING")]) },
          },
        });
      }
      return empty(args);
    });
    const result = await fetchPrUpstream("acme/shop", 7, run);
    expect(result.threads.map((item) => item.id)).toEqual(["long", "resolved"]);
    expect(result.threads[0]?.comments.map((item) => item.id)).toEqual(["first", "second"]);
    expect(result.threads[0]?.comments[0]?.reviewId).toBe("123");
    expect(result.threads[1]).toMatchObject({ resolved: true, outdated: true, line: null });
    const panel = pullRequestPanelData(
      { number: 7, title: "Change", url: "https://github.com/acme/shop/pull/7", repo: "acme/shop" },
      {
        ...result,
        reviews: [
          {
            id: "123",
            author: "ola",
            state: "CHANGES_REQUESTED",
            body: "Fix this",
            url: "https://github.com/acme/shop/pull/7#review-123",
            at: "2026-11-12T10:00:00Z",
          },
        ],
      },
    );
    const review = panel.activity.find((item) => item.kind === "review")!;
    const root = panel.activity.find((item) => item.threadId === "long")!;
    expect(root.reviewId).toBe(review.id);
    expect(review.reviewState).toBe("changes_requested");
    expect(root.location).toMatchObject({
      path: "file.ts",
      line: 4,
      isResolved: false,
      isOutdated: false,
    });
    expect(panel.activity.find((item) => item.threadId === "resolved")?.location).toMatchObject({
      isResolved: true,
      isOutdated: true,
    });
  });

  it("refetches unchanged heads and handles a PR without checks", async () => {
    const run = vi.fn(async (args: string[]) =>
      args.some((arg) => arg.includes("InboxChecks"))
        ? JSON.stringify({ data: { repository: { object: { statusCheckRollup: null } } } })
        : empty(args),
    );
    expect((await fetchPrUpstream("acme/shop", 7, run)).checks).toEqual([]);
    await fetchPrUpstream("acme/shop", 7, run);
    expect(run.mock.calls.filter(([args]) => args[0] === "pr")).toHaveLength(2);
    expect(
      run.mock.calls.filter(([args]) => args.some((arg) => arg.includes("/reviews?"))),
    ).toHaveLength(2);
  });

  it("surfaces request and partial GraphQL errors instead of empty success", async () => {
    const rejected = async (args: string[]) => {
      if (args.some((arg) => arg.includes("/issues/"))) throw new Error("GitHub rate limit");
      return empty(args);
    };
    await expect(fetchPrUpstream("acme/shop", 7, rejected)).rejects.toThrow("GitHub rate limit");
    const partial = async (args: string[]) =>
      args.some((arg) => arg.includes("InboxThreads"))
        ? JSON.stringify({ data: { repository: null }, errors: [{ message: "Forbidden" }] })
        : empty(args);
    await expect(fetchPrUpstream("acme/shop", 7, partial)).rejects.toThrow("Forbidden");
  });

  it("rejects a repeated pagination cursor", async () => {
    const run = async (args: string[]) =>
      args.some((arg) => arg.includes("InboxChecks"))
        ? JSON.stringify({
            data: { repository: { object: { statusCheckRollup: { contexts: page([], "same") } } } },
          })
        : empty(args);
    await expect(fetchPrUpstream("acme/shop", 7, run)).rejects.toThrow("invalid pagination cursor");
  });
});

describe("queryArgs", () => {
  it("keeps quoted qualifier values together", () => {
    expect(queryArgs('is:open label:"needs qa" org:acme')).toEqual([
      "is:open",
      "label:needs qa",
      "org:acme",
    ]);
  });
});

describe("GithubSource", () => {
  const hit = (updatedAt: string) => ({
    number: 7,
    title: "Add the basket page",
    url: "https://github.com/Acme/Shop/pull/7",
    isDraft: false,
    updatedAt,
    labels: [{ name: "needs-qa" }],
    repository: { nameWithOwner: "Acme/Shop" },
    author: { login: "ola" },
  });
  const details = {
    headRefOid: "abc",
    files: [{ path: "src/a.tsx" }],
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
    additions: 5,
    deletions: 1,
  };

  it("maps a search to PRs and fetches details only when the PR changed", async () => {
    let updatedAt = "2026-11-04T10:00:00Z";
    const run = vi.fn(async (args: string[]) =>
      JSON.stringify(args[0] === "search" ? [hit(updatedAt)] : details),
    );
    const source = new GithubSource(run);
    const [pr] = await source.search("is:open label:needs-qa");
    expect(pr).toEqual({
      key: "acme/shop#7",
      repo: "Acme/Shop",
      number: 7,
      url: "https://github.com/Acme/Shop/pull/7",
      title: "Add the basket page",
      headSha: "abc",
      isDraft: false,
      labels: ["needs-qa"],
      files: ["src/a.tsx"],
      checks: "failing",
      author: "ola",
      additions: 5,
      deletions: 1,
      updatedAt: "2026-11-04T10:00:00Z",
    });
    expect(run.mock.calls[0]![0].slice(0, 4)).toEqual([
      "search",
      "prs",
      "is:open",
      "label:needs-qa",
    ]);
    await source.search("is:open label:needs-qa");
    expect(run).toHaveBeenCalledTimes(3);
    updatedAt = "2026-11-04T11:00:00Z";
    await source.search("is:open label:needs-qa");
    expect(run).toHaveBeenCalledTimes(5);
  });
});

describe("PrDetailsCache", () => {
  const pull = (sha: string) => ({
    body: "## Why",
    user: { login: "ola" },
    base: { ref: "main" },
    head: { ref: "feat/x", sha },
    additions: 5,
    deletions: 1,
    changed_files: 1,
    created_at: "2026-11-04T10:00:00Z",
  });
  const files = [
    [
      {
        filename: "src/a.tsx",
        status: "modified",
        additions: 5,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-a\n+b",
      },
    ],
    [{ filename: "logo.png", status: "added", additions: 0, deletions: 0 }],
  ];

  it("reads description and every file page, and refetches files only after a push", async () => {
    let sha = "abc";
    const run = vi.fn(async (args: string[]) =>
      JSON.stringify(
        args.some((arg) => arg.includes("/files"))
          ? files
          : args.some((arg) => arg.includes("/comments"))
            ? [[]]
            : pull(sha),
      ),
    );
    const cache = new PrDetailsCache(run);
    const details = await cache.get("acme/shop", 7);
    expect(details).toMatchObject({
      body: "## Why",
      author: "ola",
      baseRef: "main",
      headRef: "feat/x",
      headSha: "abc",
      changedFiles: 1,
    });
    expect(details.files.map((file) => [file.path, file.patch !== undefined])).toEqual([
      ["src/a.tsx", true],
      ["logo.png", false],
    ]);
    await cache.get("acme/shop", 7);
    // pull + files + threads; a second read skips files (same head) but re-reads threads.
    expect(run).toHaveBeenCalledTimes(5);
    sha = "def";
    await cache.get("acme/shop", 7);
    expect(run).toHaveBeenCalledTimes(8);
  });
});
