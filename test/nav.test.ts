import { describe, expect, it, vi } from "vitest";
import { openReview, openReviewerChat, setOpenScreen } from "../client/nav";

describe("openReview", () => {
  it("opens the review in the Explorer sidebar of the run's workspace, or over the app without one", () => {
    const open = vi.fn();
    setOpenScreen(open);
    openReview("run-1", "ws-1");
    openReview("run-2", null);
    expect(open.mock.calls).toEqual([
      [{ screenId: "review", params: { runId: "run-1" }, workspaceId: "ws-1", location: "explorer" }],
      [{ screenId: "review", params: { runId: "run-2" } }],
    ]);
  });
});

describe("openReviewerChat", () => {
  function setup() {
    const calls: unknown[] = [];
    setOpenScreen((input) => calls.push(["screen", input]));
    const navigation = { openAgent: (input: { agentId: string }) => calls.push(["agent", input]), openWorkspace: vi.fn() };
    return { calls, navigation };
  }

  it("opens the chat in the main pane, then keeps the review beside it in the Explorer sidebar", () => {
    const { calls, navigation } = setup();
    openReviewerChat(navigation, { id: "run-1", agentId: "agent-1", workspaceId: "ws-1" }, false);
    expect(calls).toEqual([
      ["agent", { agentId: "agent-1" }],
      ["screen", { screenId: "review", params: { runId: "run-1" }, workspaceId: "ws-1", location: "explorer" }],
    ]);
  });

  it("only opens the chat on compact layouts or when the run has no workspace", () => {
    const { calls, navigation } = setup();
    openReviewerChat(navigation, { id: "run-1", agentId: "agent-1", workspaceId: "ws-1" }, true);
    openReviewerChat(navigation, { id: "run-2", agentId: "agent-2" }, false);
    expect(calls).toEqual([
      ["agent", { agentId: "agent-1" }],
      ["agent", { agentId: "agent-2" }],
    ]);
  });
});
