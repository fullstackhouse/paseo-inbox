import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useState } from "react";
import { listInbox, pollNow, type InboxView } from "../shared/inbox";

/** The daemon's inbox view, refreshed every `everyMs`. */
export function useInbox(everyMs = 15_000) {
  const list = useRpc(listInbox);
  const poll = useRpc(pollNow);
  const [view, setView] = useState<InboxView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setView(await list({}));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [list]);

  const pollNowAndRefresh = useCallback(async () => {
    setPolling(true);
    try {
      setView(await poll({}));
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
