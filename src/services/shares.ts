import { useSyncExternalStore } from "react";
import { backend, type ShareInfo } from "./backend";

/**
 * Session shares as the backend reports them (`share-state`), plus which pane's share
 * dialog this window shows. Each window keeps its own copy; the backend is the source of truth.
 */

interface ShareStore {
  shares: ShareInfo[];
  /** Pane whose share dialog is open in this window. */
  dialogPane: string | null;
  /** A relay address is saved (sharing needs one). */
  relayConfigured: boolean;
}

let state: ShareStore = { shares: [], dialogPane: null, relayConfigured: false };
const listeners = new Set<() => void>();
let started = false;

function set(patch: Partial<ShareStore>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function start() {
  if (started) return;
  started = true;
  void backend.shareList().then((shares) => set({ shares }));
  void backend.onShareState((shares) => set({ shares }));
}

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useShareStore(): ShareStore {
  return useSyncExternalStore(subscribe, () => state);
}

export const shareStore = {
  openDialog(paneId: string) {
    set({ dialogPane: paneId });
  },
  closeDialog() {
    set({ dialogPane: null });
  },
  setRelayConfigured(on: boolean) {
    if (state.relayConfigured !== on) set({ relayConfigured: on });
  },
  get relayConfigured() {
    return state.relayConfigured;
  },
};
