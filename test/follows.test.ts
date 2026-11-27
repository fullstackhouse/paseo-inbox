import { describe, expect, it } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { PrFollows, VISIBLE_UNUSED_MS } from "../server/follows";
import type { HostChangeRequestRead, HostSubscriptionTarget, HostSubscriptionUpdate } from "../server/host-sdk";

const A = "https://github.com/o/r/pull/1";
const B = "https://github.com/o/r/pull/2";

const read = (url: string, overrides: Record<string, unknown> = {}): HostChangeRequestRead =>
  ({ url, ok: true, number: 1, title: "T", state: "open", isDraft: false, checksState: "passing", headSha: "sha1", ...overrides }) as HostChangeRequestRead;

function fakeHost(reads: Record<string, HostChangeRequestRead> = {}) {
  const subscriptions: { target: HostSubscriptionTarget; onUpdate: (update: HostSubscriptionUpdate) => void; live: boolean }[] = [];
  const api = {
    changeRequests: {
      subscribe: async (target: HostSubscriptionTarget, onUpdate: (update: HostSubscriptionUpdate) => void) => {
        const subscription = { target, onUpdate, live: true };
        subscriptions.push(subscription);
        return { initial: { results: (target.urls ?? []).map((url) => reads[url] ?? read(url)), branches: [] }, unsubscribe: async () => void (subscription.live = false) };
      },
    },
  } as unknown as PaseoApi;
  const push = (result: HostChangeRequestRead) => {
    for (const subscription of subscriptions) if (subscription.live && subscription.target.urls?.includes(result.url)) subscription.onUpdate({ results: [result], branches: [] });
  };
  return { api, subscriptions, push, live: () => subscriptions.filter((subscription) => subscription.live) };
}

describe("PrFollows", () => {
  it("follows open runs' PRs in the background and serves what the host pushed", async () => {
    const host = fakeHost();
    const follows = new PrFollows(() => host.api);
    expect((await follows.live([A])).get(A)).toEqual({ checks: "passing", isDraft: false, headSha: "sha1", state: "open" });
    host.push(read(A, { checksState: "failing" }));
    expect((await follows.live([A])).get(A)?.checks).toBe("failing");
    expect(host.subscriptions.map((subscription) => subscription.target)).toEqual([{ urls: [A], priority: "background" }]);
  });

  it("follows the review screen's PR as visible with deployments, upgrading a background follow", async () => {
    const deployments = [{ environment: "preview", state: "SUCCESS", createdAt: "2026-11-27T10:00:00Z", url: "https://pr-1.example.dev" }];
    const host = fakeHost({ [A]: read(A, { deployments }) });
    const follows = new PrFollows(() => host.api);
    await follows.live([A]);
    expect(await follows.deployments(A)).toEqual([{ state: "ready", label: "pr-1.example.dev", link: "https://pr-1.example.dev" }]);
    expect(host.live().map((subscription) => subscription.target)).toEqual([{ urls: [A], priority: "visible", include: ["deployments"] }]);
  });

  it("unfollows closed runs' PRs, and a review screen's PR once nobody looked at it for a while", async () => {
    let now = 0;
    const host = fakeHost();
    const follows = new PrFollows(() => host.api, () => now);
    await follows.live([A, B]);
    await follows.deployments(B);
    await follows.retain([]);
    expect(host.live().map((subscription) => subscription.target.urls)).toEqual([[B]]);
    now = VISIBLE_UNUSED_MS;
    await follows.retain([]);
    expect(host.live()).toEqual([]);
  });

  it("does nothing on hosts without the PR service", async () => {
    const follows = new PrFollows(() => ({}) as PaseoApi);
    expect(follows.available).toBe(false);
    expect(await follows.deployments(A)).toBeNull();
  });
});
