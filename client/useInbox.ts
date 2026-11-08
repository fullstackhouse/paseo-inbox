import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { listInbox, pollNow, type InboxView } from "../shared/inbox";

// One view shared by every useInbox caller, so an action on one screen updates the sidebar count at once.
let shared: InboxView | null = null;
const listeners = new Set<() => void>();
const publish = (view: InboxView) => {
  shared = view;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => shared;

/** The daemon's inbox view, refreshed every `everyMs` and whenever any other caller refreshes it. */
export function useInbox(everyMs = 15_000) {
  const list = useRpc(listInbox);
  const poll = useRpc(pollNow);
  const view = useSyncExternalStore(subscribe, snapshot);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  const refresh = useCallback(async () => {
    try {
      publish(await list({}));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [list]);

  const pollNowAndRefresh = useCallback(async () => {
    setPolling(true);
    try {
      publish(await poll({}));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPolling(false);
    }
  }, [poll]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), everyMs);
    return () => clearInterval(timer);
  }, [refresh, everyMs]);

  return { view, error, polling, refresh, pollNow: pollNowAndRefresh };
}
