import { describe, expect, it, vi } from "vitest";
import { GithubSource, queryArgs, summarizeChecks } from "../server/github";

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
  });
  const details = { headRefOid: "abc", files: [{ path: "src/a.tsx" }], statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] };

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
    });
    expect(run.mock.calls[0]![0].slice(0, 4)).toEqual(["search", "prs", "is:open", "label:needs-qa"]);
    await source.search("is:open label:needs-qa");
    expect(run).toHaveBeenCalledTimes(3);
    updatedAt = "2026-11-04T11:00:00Z";
    await source.search("is:open label:needs-qa");
    expect(run).toHaveBeenCalledTimes(5);
  });
});
