import { useEffect, useState } from "react";
import { subscribeServerMonitor, type MonitorState } from "../services/serverMonitor";

/** Live resource stats of the SSH host behind `paneId`; null pane = not monitoring. */
export function useServerMonitor(paneId: string | null): MonitorState | null {
  const [state, setState] = useState<MonitorState | null>(null);
  useEffect(() => {
    if (!paneId) {
      setState(null);
      return;
    }
    return subscribeServerMonitor(paneId, setState);
  }, [paneId]);
  return state;
}
