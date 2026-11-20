import { describe, expect, it, vi } from "vitest";
import { openReview, openReviewerChat, setOpenScreen } from "../client/nav";

describe("openReview", () => {
  it("opens the review in the Explorer sidebar of the run's workspace, or over the app without one", () => {
    const open = vi.fn();
    setOpenScreen(open, { explorerTabs: true });
    openReview("run-1", "ws-1");
    openReview("run-2", null);
    expect(open.mock.calls).toEqual([
      [{ screenId: "review", params: { runId: "run-1" }, workspaceId: "ws-1", location: "explorer" }],
      [{ screenId: "review", params: { runId: "run-2" } }],
    ]);
  });

  it("keeps the review in the main pane on hosts that can't put it in Explorer", () => {
    const open = vi.fn();
    setOpenScreen(open);
    openReview("run-1", "ws-1");
    expect(open.mock.calls).toEqual([[{ screenId: "review", params: { runId: "run-1" }, workspaceId: "ws-1" }]]);
  });
});

describe("openReviewerChat", () => {
  function setup(explorerTabs: boolean) {
    const calls: unknown[] = [];
    setOpenScreen((input) => calls.push(["screen", input]), { explorerTabs });
    const navigation = { openAgent: (input: { agentId: string }) => calls.push(["agent", input]), openWorkspace: vi.fn() };
    return { calls, navigation };
  }

  it("opens the chat in the main pane, then keeps the review beside it in the Explorer sidebar", () => {
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

  it("only opens the chat on hosts that can't put the review in Explorer, so the review doesn't take focus back", () => {
    const { calls, navigation } = setup(false);
    openReviewerChat(navigation, { id: "run-1", agentId: "agent-1", workspaceId: "ws-1" }, false);
    expect(calls).toEqual([["agent", { agentId: "agent-1" }]]);
  });
});
