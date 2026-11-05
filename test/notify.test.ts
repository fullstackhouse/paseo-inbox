import { describe, expect, it, vi } from "vitest";
import { notifyDraftReady } from "../index.server";

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
