import type { Terminal } from "@xterm/xterm";
import type { McpScreenSnapshot } from "../types/domain";
import { backend } from "./backend";

/**
 * Answers the MCP `read_screen` tool: the backend emits `mcp-read-screen` to every window,
 * and the one showing the pane replies with its xterm.js screen as text.
 */

const terminals = new Map<string, Terminal>();
/** run_command typed a command into the pane (for its history). */
const commandHooks = new Map<string, (command: string) => void>();
let installed = false;

/** Screen text of `term`: the visible rows plus `scrollback` rows above them. */
export function screenSnapshot(term: Terminal, scrollback: number): McpScreenSnapshot {
  const buf = term.buffer.active;
  const top = Math.max(0, buf.viewportY - Math.max(0, scrollback));
  const end = buf.viewportY + term.rows;
  const lines: string[] = [];
  for (let y = top; y < end; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    // Soft-wrapped rows continue the previous line.
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return {
    text: lines.join("\n"),
    cols: term.cols,
    rows: term.rows,
    // xterm parks the cursor one past the last column while a wrap is pending.
    cursorX: Math.min(buf.cursorX, term.cols - 1),
    // Relative to the visible screen, which is what the agent sees.
    cursorY: buf.baseY + buf.cursorY - buf.viewportY,
    alternate: buf.type === "alternate",
  };
}

/** A pane's xterm.js instance, while it is mounted in this window. */
export function registerMcpScreen(paneId: string, term: Terminal, onCommand: (command: string) => void): () => void {
  terminals.set(paneId, term);
  commandHooks.set(paneId, onCommand);
  if (!installed) {
    installed = true;
    void backend.onMcpReadScreen(({ requestId, instanceId, scrollback }) => {
      const t = terminals.get(instanceId);
      if (t) void backend.mcpScreenReply(requestId, screenSnapshot(t, scrollback));
    });
    // Every window gets the event; only the one showing the pane has a hook for it.
    void backend.onMcpCommand(({ instanceId, command }) => commandHooks.get(instanceId)?.(command));
  }
  return () => {
    if (terminals.get(paneId) === term) {
      terminals.delete(paneId);
      commandHooks.delete(paneId);
    }
  };
}
