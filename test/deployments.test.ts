import { describe, expect, it } from "vitest";
import { fetchPrDeployments } from "../server/upstream";
import { deployEntries, deployRefetch, type Deployment } from "../shared/upstream";

const deployment = (over: Partial<Deployment>): Deployment => ({
  environment: "preview",
  createdAt: "2026-11-18T10:00:00Z",
  state: "SUCCESS",
  logUrl: "https://github.com/acme/shop/actions/runs/1",
  url: "https://pr-7.shop.example",
  ...over,
});

describe("deployEntries", () => {
  it("renders nothing without deployments", () => {
    expect(deployEntries([])).toEqual([]);
  });

  it("keeps one entry per URL, the newest deployment winning, labelled by host", () => {
    expect(
      deployEntries([
        deployment({ createdAt: "2026-11-18T10:00:00Z", state: "FAILURE", logUrl: "https://ci/old" }),
        deployment({ createdAt: "2026-11-18T11:00:00Z", state: "SUCCESS" }),
        deployment({ url: "https://docs-pr-7.shop.example/guide", state: "IN_PROGRESS", logUrl: "https://ci/docs" }),
      ]),
    ).toEqual([
      { state: "deploying", label: "docs-pr-7.shop.example", link: "https://ci/docs" },
      { state: "ready", label: "pr-7.shop.example", link: "https://pr-7.shop.example" },
    ]);
  });

  it("maps states and links: ready → URL, deploying/failed → log (URL when there is none)", () => {
    const one = (over: Partial<Deployment>) => deployEntries([deployment(over)]);
    for (const state of ["IN_PROGRESS", "QUEUED", "PENDING"]) expect(one({ state })[0]).toMatchObject({ state: "deploying", link: "https://github.com/acme/shop/actions/runs/1" });
    for (const state of ["FAILURE", "ERROR"]) expect(one({ state })[0]?.state).toBe("failed");
    expect(one({ state: "FAILURE", logUrl: null })[0]?.link).toBe("https://pr-7.shop.example");
    expect(one({ state: "SUCCESS" })[0]?.link).toBe("https://pr-7.shop.example");
  });

  it("shows inactive URLs only when nothing else is there", () => {
    const inactive = deployment({ url: "https://old.shop.example", state: "INACTIVE" });
    expect(deployEntries([inactive, deployment({})]).map((entry) => entry.label)).toEqual(["pr-7.shop.example"]);
    expect(deployEntries([inactive, deployment({ url: "https://x.shop.example", state: null })])).toEqual([
      { state: "inactive", label: "old.shop.example", link: "https://old.shop.example" },
      { state: "inactive", label: "x.shop.example", link: "https://x.shop.example" },
    ]);
  });

  it("collapses URL-less deployments into one Deploying entry while any runs, else ignores them", () => {
    const bare = (over: Partial<Deployment>) => deployment({ url: null, environment: "shop-cd", ...over });
    expect(deployEntries([bare({ state: "SUCCESS" }), bare({ state: "FAILURE" }), bare({ state: "INACTIVE" })])).toEqual([]);
    expect(
      deployEntries([
        bare({ state: "IN_PROGRESS", createdAt: "2026-11-18T10:00:00Z", logUrl: "https://ci/a" }),
        bare({ state: "QUEUED", createdAt: "2026-11-18T11:00:00Z", logUrl: "https://ci/b" }),
        bare({ state: "SUCCESS" }),
      ]),
    ).toEqual([{ state: "deploying", label: "shop-cd", link: "https://ci/b" }]);
  });

  it("polls only while something deploys", () => {
    expect(deployRefetch(undefined)).toBe(false);
    expect(deployRefetch(deployEntries([deployment({})]))).toBe(false);
    expect(deployRefetch(deployEntries([deployment({ state: "PENDING" })]))).toBe(30_000);
  });
});

describe("fetchPrDeployments", () => {
  it("reads the head commit's deployments in one GraphQL call, URL from the first status that has one", async () => {
    const calls: string[][] = [];
    const node = (createdAt: string, state: string | null, urls: (string | null)[]) => ({
      environment: "Preview",
      createdAt,
      latestStatus: state ? { state, logUrl: "https://vercel.example/logs" } : null,
      statuses: { nodes: urls.map((environmentUrl) => ({ environmentUrl })) },
    });
    const result = await fetchPrDeployments("acme/shop", 7, async (args) => {
      calls.push(args);
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              commits: {
                nodes: [
                  {
                    commit: {
                      deployments: {
                        nodes: [node("2026-11-18T10:00:00Z", "SUCCESS", [null, "https://shop-abc.vercel.app"]), node("2026-11-18T09:00:00Z", null, [])],
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      });
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("number=7");
    expect(result).toEqual([{ state: "ready", label: "shop-abc.vercel.app", link: "https://shop-abc.vercel.app" }]);
  });
});
