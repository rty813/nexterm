/**
 * Working directory each terminal pane reported last (OSC 7 from shell integration).
 * Kept outside React state: prompts redraw often and only the file browser listens.
 */
type Listener = (paneId: string, cwd: string) => void;

const cwds = new Map<string, string>();
const listeners = new Set<Listener>();

export const paneCwd = {
  set(paneId: string, cwd: string): void {
    if (cwds.get(paneId) === cwd) return;
    cwds.set(paneId, cwd);
    listeners.forEach((l) => l(paneId, cwd));
  },
  get(paneId: string): string | undefined {
    return cwds.get(paneId);
  },
  forget(paneId: string): void {
    cwds.delete(paneId);
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
};
