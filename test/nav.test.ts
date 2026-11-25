import { describe, expect, it, vi } from "vitest";
import { openReview, openReviewerChat, setOpenScreen } from "../client/nav";
import type { ReviewLocation } from "../shared/inbox";

describe("openReview", () => {
  it("opens the review as a main-view tab of the run's workspace by default, or over the app without one", () => {
    const open = vi.fn();
    setOpenScreen(open, { explorerTabs: true, reviewLocation: () => undefined });
    openReview("run-1", "ws-1");
    openReview("run-2", null);
    expect(open.mock.calls).toEqual([
      [{ screenId: "review", params: { runId: "run-1" }, workspaceId: "ws-1" }],
      [{ screenId: "review", params: { runId: "run-2" } }],
    ]);
  });

  it("opens the review in the Explorer sidebar when the human chose it", () => {
    const open = vi.fn();
    let location: ReviewLocation = "explorer";
    setOpenScreen(open, { explorerTabs: true, reviewLocation: () => location });
    openReview("run-1", "ws-1");
    location = "main";
    openReview("run-1", "ws-1");
    expect(open.mock.calls).toEqual([
      [{ screenId: "review", params: { runId: "run-1" }, workspaceId: "ws-1", location: "explorer" }],
      [{ screenId: "review", params: { runId: "run-1" }, workspaceId: "ws-1" }],
    ]);
  });

  it("keeps the review in the main view on hosts that can't put it in Explorer", () => {
    const open = vi.fn();
    setOpenScreen(open, { reviewLocation: () => "explorer" });
    openReview("run-1", "ws-1");
    expect(open.mock.calls).toEqual([[{ screenId: "review", params: { runId: "run-1" }, workspaceId: "ws-1" }]]);
  });
});

describe("openReviewerChat", () => {
  function setup(explorerTabs: boolean, reviewLocation: ReviewLocation = "explorer") {
    const calls: unknown[] = [];
    setOpenScreen((input) => calls.push(["screen", input]), { explorerTabs, reviewLocation: () => reviewLocation });
    const navigation = { openAgent: (input: { agentId: string }) => calls.push(["agent", input]), openWorkspace: vi.fn() };
    return { calls, navigation };
  }

  it("with reviews in Explorer, opens the chat in the main pane, then keeps the review beside it", () => {
    const { calls, navigation } = setup(true);
    openReviewerChat(navigation, { id: "run-1", agentId: "agent-1", workspaceId: "ws-1" }, false);
    expect(calls).toEqual([
      ["agent", { agentId: "agent-1" }],
      ["screen", { screenId: "review", params: { runId: "run-1" }, workspaceId: "ws-1", location: "explorer" }],
    ]);
  });

  it("only opens the chat on compact layouts or when the run has no workspace", () => {
    const { calls, navigation } = setup(true);
    openReviewerChat(navigation, { id: "run-1", agentId: "agent-1", workspaceId: "ws-1" }, true);
    openReviewerChat(navigation, { id: "run-2", agentId: "agent-2" }, false);
    expect(calls).toEqual([
      ["agent", { agentId: "agent-1" }],
      ["agent", { agentId: "agent-2" }],
    ]);
  });

  it("only opens the chat with reviews in the main view, so the review tab doesn't take focus back", () => {
    for (const [explorerTabs, location] of [[true, "main"], [false, "explorer"]] as const) {
      const { calls, navigation } = setup(explorerTabs, location);
      openReviewerChat(navigation, { id: "run-1", agentId: "agent-1", workspaceId: "ws-1" }, false);
      expect(calls).toEqual([["agent", { agentId: "agent-1" }]]);
    }
  });
});
