import type { PluginOpenScreenInput } from "@getpaseo/plugin/client";

/** paseo-inbox's review screen. Other plugins open it by this id, so it is a public contract. */
export const REVIEW_SCREEN = "review";

// COMPAT(screenTabs): the FSH host opens a screen as a tab of `workspaceId`; @getpaseo/plugin 0.15.3 has no
// type for it yet, and older hosts ignore it and open the screen over the app. Drop once the SDK ships it.
type OpenScreenInput = PluginOpenScreenInput & { workspaceId?: string };

// Screens get no openScreen prop; the client entry hands the context's one over at startup.
let open: ((input: OpenScreenInput) => void) | null = null;
export const setOpenScreen = (fn: (input: PluginOpenScreenInput) => void) => {
  open = fn;
};
export const openScreen = (input: OpenScreenInput) => open?.(input);

/** Opens a run's review: as a tab next to its reviewer when the run has a workspace, else over the app. */
export const openReview = (runId: string, workspaceId?: string | null) =>
  openScreen({ screenId: REVIEW_SCREEN, params: { runId }, ...(workspaceId ? { workspaceId } : {}) });
