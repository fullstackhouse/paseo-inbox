import type { PluginButton, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { listInbox, reviewPill } from "../shared/inbox";
import { getReview, postReview, type Verdict } from "../shared/review";
import { openScreen } from "./nav";
import { makePostPopover, type PostStore } from "./PostReviewPopover";
import { REVIEW_SCREEN } from "./ReviewScreen";
import { publish, snapshot, subscribe } from "./useInbox";

const POLL_MS = 15_000;

type Pills = {
  runId: string;
  label: string;
  open: PluginButtonRegistration;
  /** Present while the draft can be posted. */
  post: { verdict: Verdict; registration: PluginButtonRegistration } | null;
};

const postFace = (verdict: Verdict) => ({ title: "Post the review to GitHub", label: `Post as ${verdict}…` });

/**
 * Composer pills on each inbox agent's chat: "Open review", and "Post as <verdict>…" while the draft
 * can be posted, which confirms in a popover first. They stay above the composer, where the timeline
 * card they replace scrolled away, and follow the shared inbox view, so a Post or Dismiss on another
 * screen updates them at once.
 */
export function contributeReviewPills(client: PluginClientContext): () => void {
  const pills = new Map<string, Pills>();
  const listeners = new Set<() => void>();
  const refresh = () => client.rpc(listInbox, {}).then(publish);

  const store: PostStore = {
    runFor: (agentId) => {
      const pill = pills.get(agentId);
      return pill?.post ? pill.runId : undefined;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    draft: (runId) => client.rpc(getReview, { runId }),
    async post(runId) {
      await client.rpc(postReview, { runId });
      void refresh().catch(() => undefined);
    },
  };
  // One behavior for every Post pill: replacing it would close an open popover mid-use.
  const postBehavior: PluginButton["behavior"] = { kind: "popover", Content: makePostPopover(store) };

  const sync = () => {
    const view = snapshot();
    if (!view) return;
    const wanted = new Map<string, { workspaceId: string; runId: string; label: string; postAs: Verdict | null }>();
    for (const run of view.runs) {
      if (!run.agentId || !run.workspaceId || wanted.has(run.agentId)) continue;
      const pill = reviewPill(view.runs, view, run.agentId);
      if (pill) wanted.set(run.agentId, { workspaceId: run.workspaceId, ...pill });
    }
    for (const [agentId, pill] of pills) {
      if (wanted.has(agentId)) continue;
      pill.open.remove();
      pill.post?.registration.remove();
      pills.delete(agentId);
    }
    for (const [agentId, { workspaceId, runId, label, postAs }] of wanted) {
      const openBehavior = { kind: "action" as const, onPress: () => openScreen({ screenId: REVIEW_SCREEN, params: { runId } }) };
      const existing = pills.get(agentId);
      const open = existing?.open ?? client.addComposerPill({ id: "review", workspaceId, agentId, button: { title: "Open the review", icon: "ClipboardCheck", label, behavior: openBehavior } });
      if (existing && (existing.runId !== runId || existing.label !== label)) open.update({ label, behavior: openBehavior });

      let post = existing?.post ?? null;
      if (!postAs) {
        post?.registration.remove();
        post = null;
      } else if (!post) {
        post = { verdict: postAs, registration: client.addComposerPill({ id: "post", workspaceId, agentId, button: { ...postFace(postAs), icon: "Send", behavior: postBehavior } }) };
      } else if (post.verdict !== postAs) {
        post.registration.update(postFace(postAs));
        post = { ...post, verdict: postAs };
      }
      pills.set(agentId, { runId, label, open, post });
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
    for (const pill of pills.values()) {
      pill.open.remove();
      pill.post?.registration.remove();
    }
    pills.clear();
  };
}
