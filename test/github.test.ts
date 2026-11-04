import { describe, expect, it, vi } from "vitest";
import { GithubSource, PrDetailsCache, queryArgs, summarizeChecks } from "../server/github";

describe("summarizeChecks", () => {
  it("prefers failing, then pending, then passing", () => {
    expect(summarizeChecks([])).toBe("none");
    expect(summarizeChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "SKIPPED" }])).toBe("passing");
    expect(summarizeChecks([{ status: "IN_PROGRESS", conclusion: null }, { status: "COMPLETED", conclusion: "SUCCESS" }])).toBe("pending");
    expect(summarizeChecks([{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "FAILURE" }])).toBe("failing");
    expect(summarizeChecks([{ state: "ERROR" }])).toBe("failing");
    expect(summarizeChecks([{ state: "PENDING" }])).toBe("pending");
  });
});

describe("queryArgs", () => {
  it("keeps quoted qualifier values together", () => {
    expect(queryArgs('is:open label:"needs qa" org:acme')).toEqual(["is:open", "label:needs qa", "org:acme"]);
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
  const details = { headRefOid: "abc", files: [{ path: "src/a.tsx" }], statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }], additions: 5, deletions: 1 };

  it("maps a search to PRs and fetches details only when the PR changed", async () => {
    let updatedAt = "2026-11-04T10:00:00Z";
    const run = vi.fn(async (args: string[]) => JSON.stringify(args[0] === "search" ? [hit(updatedAt)] : details));
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
    });
    expect(run.mock.calls[0]![0].slice(0, 4)).toEqual(["search", "prs", "is:open", "label:needs-qa"]);
    await source.search("is:open label:needs-qa");
    expect(run).toHaveBeenCalledTimes(3);
    updatedAt = "2026-11-04T11:00:00Z";
    await source.search("is:open label:needs-qa");
    expect(run).toHaveBeenCalledTimes(5);
  });
});

describe("PrDetailsCache", () => {
  const pull = (sha: string) => ({ body: "## Why", user: { login: "ola" }, base: { ref: "main" }, head: { ref: "feat/x", sha }, additions: 5, deletions: 1, changed_files: 1, created_at: "2026-11-04T10:00:00Z" });
  const files = [[{ filename: "src/a.tsx", status: "modified", additions: 5, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" }], [{ filename: "logo.png", status: "added", additions: 0, deletions: 0 }]];

  it("reads description and every file page, and refetches files only after a push", async () => {
    let sha = "abc";
    const run = vi.fn(async (args: string[]) => JSON.stringify(args.some((arg) => arg.includes("/files")) ? files : args.some((arg) => arg.includes("/comments")) ? [[]] : pull(sha)));
    const cache = new PrDetailsCache(run);
    const details = await cache.get("acme/shop", 7);
    expect(details).toMatchObject({ body: "## Why", author: "ola", baseRef: "main", headRef: "feat/x", headSha: "abc", changedFiles: 1 });
    expect(details.files.map((file) => [file.path, file.patch !== undefined])).toEqual([["src/a.tsx", true], ["logo.png", false]]);
    await cache.get("acme/shop", 7);
    // pull + files + threads; a second read skips files (same head) but re-reads threads.
    expect(run).toHaveBeenCalledTimes(5);
    sha = "def";
    await cache.get("acme/shop", 7);
    expect(run).toHaveBeenCalledTimes(8);
  });
});
