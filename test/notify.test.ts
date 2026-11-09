import { describe, expect, it, vi } from "vitest";
import { notifyDraftReady, notifyRunEnded } from "../index.server";

describe("notifyDraftReady", () => {
  const draft = { runId: "acme/shop#7|draft-review|abc", pr: "acme/shop#7", title: "Add the basket page", headline: "approve · 90% · 1 nit" };
  it("sends a notification that opens the review, keyed by run", async () => {
    const send = vi.fn(async () => ({ delivered: true }));
    expect(await notifyDraftReady({ notifications: { send } }, draft)).toBe(true);
    expect(send).toHaveBeenCalledWith({ title: "Review draft ready · shop#7", body: "Add the basket page — approve · 90% · 1 nit", open: { screen: "review", params: { runId: draft.runId } }, key: `draft:${draft.runId}` });
  });
  it("does nothing on hosts without plugin notifications", async () => {
    expect(await notifyDraftReady({ agents: {} }, draft)).toBe(false);
  });
});

describe("notifyRunEnded", () => {
  const run = { runId: "acme/shop#7|draft-review|abc", pr: "acme/shop#7", title: "Add the basket page" };
  it("says a run finished without a draft and opens the Inbox", async () => {
    const send = vi.fn(async () => ({ delivered: true }));
    expect(await notifyRunEnded({ notifications: { send } }, { ...run, failed: false })).toBe(true);
    expect(send).toHaveBeenCalledWith({ title: "Inbox run finished · shop#7", body: "Add the basket page — no review draft; open the Inbox to decide", open: { screen: "inbox" }, key: `ended:${run.runId}` });
  });
  it("names the failure", async () => {
    const send = vi.fn(async () => ({ delivered: true }));
    await notifyRunEnded({ notifications: { send } }, { ...run, failed: true, reason: "rate limited" });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ title: "Inbox run failed · shop#7", body: "Add the basket page — rate limited" }));
  });
});
