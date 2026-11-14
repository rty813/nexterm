import type { IDisposable, Terminal } from "@xterm/xterm";

/**
 * Some line editors count a CJK character as one column (JumpServer / koko's menu
 * prompt is built on golang.org/x/term, which does). Their cursor-left / -right
 * moves (CSI n D / CSI n C) then land on the right half of a double-width
 * character, so Backspace or the arrow keys appear to move only "half a character".
 *
 * Well-behaved programs never park the cursor inside a wide character, so when a
 * horizontal move lands on the right half we snap it to the character boundary in
 * the direction of travel. BS (\b) and absolute positioning are left alone.
 */
export function installWideCursorFix(term: Terminal): IDisposable {
  // xterm.js has no public setter for the cursor; the active buffer exposes `x`.
  const core = (term as unknown as { _core: { buffer: { x: number; y: number; ybase: number } } })._core;

  const move = (params: (number | number[])[], dir: -1 | 1): boolean => {
    const active = term.buffer.active;
    if (active.type !== "normal") return false;
    const buf = core.buffer;
    const n = Math.max(1, Number(params[0]) || 1);
    const from = Math.min(buf.x, term.cols - 1);
    let x = Math.max(0, Math.min(term.cols - 1, from + dir * n));
    const line = active.getLine(buf.ybase + buf.y);
    if (!line || x === 0 || line.getCell(x)?.getWidth() !== 0) return false; // default handling
    x = dir < 0 ? x - 1 : Math.min(term.cols - 1, x + 1);
    buf.x = x;
    return true;
  };

  const left = term.parser.registerCsiHandler({ final: "D" }, (p) => move(p, -1));
  const right = term.parser.registerCsiHandler({ final: "C" }, (p) => move(p, 1));
  return {
    dispose: () => {
      left.dispose();
      right.dispose();
    },
  };
}
