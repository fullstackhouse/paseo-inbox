import { describe, expect, it, vi } from "vitest";
import { openReview, setOpenScreen } from "../client/nav";

describe("openReview", () => {
  it("opens the review as a tab of the run's workspace, or over the app without one", () => {
    const open = vi.fn();
    setOpenScreen(open);
    openReview("run-1", "ws-1");
    openReview("run-2", null);
    expect(open.mock.calls).toEqual([
      [{ screenId: "review", params: { runId: "run-1" }, workspaceId: "ws-1" }],
      [{ screenId: "review", params: { runId: "run-2" } }],
    ]);
  });
});
