import type { PluginOpenScreenInput, PluginPanelLocation, PluginScreenProps } from "@getpaseo/plugin/client";

/** paseo-inbox's review screen. Other plugins open it by this id, so it is a public contract. */
export const REVIEW_SCREEN = "review";

// COMPAT(screenTabs): the FSH host opens a screen as a tab of `workspaceId`; @getpaseo/plugin 0.15.3 has no
// type for it yet, and older hosts ignore it and open the screen over the app. Drop once the SDK ships it.
// COMPAT(screenTabLocation): `location: "explorer"` puts that tab in the Explorer sidebar on FSH hosts that list
// it in `screenTabLocations`; older ones ignore it. Drop the field from this type once the SDK ships it.
type OpenScreenInput = PluginOpenScreenInput & { workspaceId?: string; location?: PluginPanelLocation };

// Screens get no openScreen prop; the client entry hands the context's one over at startup, with whether
// the host can put a workspace tab in Explorer.
let open: ((input: OpenScreenInput) => void) | null = null;
let explorerTabs = false;
export const setOpenScreen = (fn: (input: PluginOpenScreenInput) => void, options?: { explorerTabs?: boolean }) => {
  open = fn;
  explorerTabs = options?.explorerTabs ?? false;
};
export const openScreen = (input: OpenScreenInput) => open?.(input);

/**
 * Opens a run's review. With a workspace it is a tab of that workspace: in its Explorer sidebar, beside the
 * reviewer chat, when the host can put it there, else in the main pane. Without one it opens over the app.
 */
export const openReview = (runId: string, workspaceId?: string | null) =>
  openScreen({ screenId: REVIEW_SCREEN, params: { runId }, ...(workspaceId ? { workspaceId, ...(explorerTabs ? { location: "explorer" as const } : {}) } : {}) });

/**
 * Opens the reviewer chat in the main pane and keeps the review beside it in the Explorer sidebar, so you
 * talk to the reviewer with the draft in view. Only opens the chat on compact layouts, where Explorer would
 * cover it, and on hosts that can't put the review in Explorer: there the review tab would take focus back.
 */
export function openReviewerChat(
  navigation: NonNullable<PluginScreenProps["navigation"]>,
  run: { id: string; agentId: string; workspaceId?: string | null },
  compact: boolean,
) {
  navigation.openAgent({ agentId: run.agentId });
  if (!compact && explorerTabs && run.workspaceId) openReview(run.id, run.workspaceId);
}
