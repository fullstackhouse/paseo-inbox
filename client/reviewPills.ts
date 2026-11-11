import type { PluginButton, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { listInbox, reviewPill } from "../shared/inbox";
import { getPrDetails, getReview, postReview, type PrFile, type Verdict } from "../shared/review";
import { openScreen } from "./nav";
import { makePostPopover, type PostStore, type PostTarget } from "./PostReviewPopover";
import { REVIEW_SCREEN } from "./ReviewScreen";
import { publish, snapshot, subscribe } from "./useInbox";

const POLL_MS = 15_000;

type Pill = {
  registration: PluginButtonRegistration;
  /** What the pill shows and does; a change replaces the face and behavior. */
  key: string;
  /** Set while the draft can be posted. */
  target: PostTarget | null;
};

/**
 * One composer pill on each inbox agent's chat (the composer holds one pill per plugin): a "Review" menu
 * with "Open review", and "Post as <verdict>…" while the draft can be posted, which confirms in a popover
 * first. Once the review is posted it opens it in one tap ("Review posted"). It stays above the composer,
 * where the timeline card it replaces scrolled away, and follows the shared inbox view, so a Post or
 * Dismiss on another screen updates it at once.
 */
export function contributeReviewPills(client: PluginClientContext): () => void {
  const pills = new Map<string, Pill>();
  const listeners = new Set<() => void>();
  // By PR and commit: a draft that can be posted is at the PR's head, so its files don't change.
  const files = new Map<string, Promise<readonly PrFile[]>>();
  const refresh = () => client.rpc(listInbox, {}).then(publish);

  const store: PostStore = {
    targetFor: (agentId) => pills.get(agentId)?.target ?? undefined,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    draft: (runId) => client.rpc(getReview, { runId }),
    files(itemKey, version) {
      const key = `${itemKey}@${version}`;
      const cached = files.get(key);
      if (cached) return cached;
      const loading = client.rpc(getPrDetails, { itemKey }).then((details) => details.files);
      files.set(key, loading);
      loading.catch(() => files.delete(key));
      return loading;
    },
    async post(runId) {
      await client.rpc(postReview, { runId });
      void refresh().catch(() => undefined);
    },
  };
  const postBehavior: PluginButton["behavior"] = { kind: "popover", Content: makePostPopover(store) };

  const button = (runId: string, posted: boolean, postAs: Verdict | null): Pick<PluginButton, "title" | "label" | "behavior"> => {
    const open = { kind: "action" as const, onPress: () => openScreen({ screenId: REVIEW_SCREEN, params: { runId } }) };
    if (posted) return { title: "Open the review", label: "Review posted", behavior: open };
    return {
      title: "Open or post the review",
      label: "Review",
      behavior: {
        kind: "menu",
        items: [
          { kind: "item", id: "open", title: "Open review", icon: "ClipboardCheck", behavior: open },
          { kind: "item", id: "post", title: postAs ? `Post as ${postAs}…` : "Post…", icon: "Send", visible: postAs !== null, behavior: postBehavior },
        ],
      },
    };
  };

  const sync = () => {
    const view = snapshot();
    if (!view) return;
    const wanted = new Map<string, { workspaceId: string; itemKey: string; runId: string; posted: boolean; postAs: Verdict | null }>();
    for (const run of view.runs) {
      if (!run.agentId || !run.workspaceId || wanted.has(run.agentId)) continue;
      const pill = reviewPill(view.runs, view, run.agentId);
      if (pill) wanted.set(run.agentId, { workspaceId: run.workspaceId, itemKey: run.itemKey, ...pill });
    }
    for (const [agentId, pill] of pills) {
      if (wanted.has(agentId)) continue;
      pill.registration.remove();
      pills.delete(agentId);
    }
    for (const [agentId, { workspaceId, itemKey, runId, posted, postAs }] of wanted) {
      const key = `${runId}\0${posted}\0${postAs ?? ""}`;
      const existing = pills.get(agentId);
      if (existing?.key === key) continue;
      // Only on a real change: a new behavior closes the menu or popover the human has open.
      if (existing) existing.registration.update(button(runId, posted, postAs));
      const registration = existing?.registration ?? client.addComposerPill({ id: "review", workspaceId, agentId, button: { icon: "ClipboardCheck", ...button(runId, posted, postAs) } });
      pills.set(agentId, { registration, key, target: postAs ? { runId, itemKey } : null });
    }
    for (const listener of listeners) listener();
  };

  const unsubscribe = subscribe(sync);
  const poll = () => void refresh().catch(() => undefined);
  poll();
  const timer = setInterval(poll, POLL_MS);

  return () => {
    clearInterval(timer);
    unsubscribe();
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear();
  };
}
