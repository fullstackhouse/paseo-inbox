import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { listInbox, reviewPill } from "../shared/inbox";
import { openScreen } from "./nav";
import { REVIEW_SCREEN } from "./ReviewScreen";
import { publish, snapshot, subscribe } from "./useInbox";

const POLL_MS = 15_000;

type Pill = { runId: string; label: string; registration: PluginButtonRegistration };

/**
 * A composer pill on each inbox agent's chat that opens its review. It stays above the composer,
 * where the timeline card it replaces scrolled away. Follows the shared inbox view, so a Post or
 * Dismiss on another screen relabels it at once.
 */
export function contributeReviewPills(client: PluginClientContext): () => void {
  const pills = new Map<string, Pill>();

  const sync = () => {
    const view = snapshot();
    if (!view) return;
    const wanted = new Map<string, { workspaceId: string; runId: string; label: string }>();
    for (const run of view.runs) {
      if (!run.agentId || !run.workspaceId || wanted.has(run.agentId)) continue;
      const pill = reviewPill(view.runs, view, run.agentId);
      if (pill) wanted.set(run.agentId, { workspaceId: run.workspaceId, ...pill });
    }
    for (const [agentId, pill] of pills) {
      if (wanted.has(agentId)) continue;
      pill.registration.remove();
      pills.delete(agentId);
    }
    for (const [agentId, { workspaceId, runId, label }] of wanted) {
      const behavior = { kind: "action" as const, onPress: () => openScreen({ screenId: REVIEW_SCREEN, params: { runId } }) };
      const existing = pills.get(agentId);
      if (!existing) {
        const registration = client.addComposerPill({ id: "review", workspaceId, agentId, button: { title: "Open review", icon: "ClipboardCheck", label, behavior } });
        pills.set(agentId, { runId, label, registration });
      } else if (existing.runId !== runId || existing.label !== label) {
        existing.registration.update({ label, behavior });
        pills.set(agentId, { ...existing, runId, label });
      }
    }
  };

  const unsubscribe = subscribe(sync);
  const refresh = () => void client.rpc(listInbox, {}).then(publish).catch(() => undefined);
  refresh();
  const timer = setInterval(refresh, POLL_MS);

  return () => {
    clearInterval(timer);
    unsubscribe();
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear();
  };
}
