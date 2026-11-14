type OutputListener = (bytes: Uint8Array) => void;

class TerminalStreamBus {
  private listeners = new Map<string, OutputListener>();
  private pendingBuffers = new Map<string, Uint8Array[]>();

  subscribe(paneId: string, listener: OutputListener): () => void {
    this.listeners.set(paneId, listener);
    const queued = this.pendingBuffers.get(paneId);
    if (queued && queued.length > 0) {
      this.pendingBuffers.delete(paneId);
      for (const chunk of queued) {
        listener(chunk);
      }
    }
    return () => {
      if (this.listeners.get(paneId) === listener) {
        this.listeners.delete(paneId);
      }
    };
  }

  publish(paneId: string, bytes: Uint8Array): void {
    const listener = this.listeners.get(paneId);
    if (listener) {
      listener(bytes);
    } else {
      const existing = this.pendingBuffers.get(paneId) ?? [];
      if (existing.length < 256) {
        existing.push(bytes);
        this.pendingBuffers.set(paneId, existing);
      }
    }
  }

  clearPane(paneId: string): void {
    this.pendingBuffers.delete(paneId);
    this.listeners.delete(paneId);
  }
}

export const terminalBus = new TerminalStreamBus();
