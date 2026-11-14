import type { IDisposable, Terminal } from "@xterm/xterm";

/** Keep xterm's IME preedit and its native candidate anchor inside the screen. */
export function installCompositionBounds(term: Terminal): IDisposable {
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  const helpers = screen?.querySelector<HTMLElement>(".xterm-helpers");
  const view = helpers?.querySelector<HTMLElement>(".composition-view");
  if (!screen || !helpers || !view) return { dispose() {} };

  let frame = 0;
  const update = () => {
    frame = 0;
    const left = Number.parseFloat(view.style.left) || 0;
    // xterm positions the view at the cursor. Shift only when it would extend
    // past the screen; keep the hidden textarea at the same visual position.
    const shift = view.classList.contains("active")
      ? Math.min(0, screen.clientWidth - left - view.offsetWidth)
      : 0;
    helpers.style.setProperty("--composition-shift", `${shift}px`);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  const mutations = new MutationObserver(schedule);
  mutations.observe(view, { attributes: true, attributeFilter: ["class", "style"], childList: true, characterData: true, subtree: true });
  const resize = new ResizeObserver(schedule);
  resize.observe(screen);
  return {
    dispose() {
      mutations.disconnect();
      resize.disconnect();
      if (frame) cancelAnimationFrame(frame);
      helpers.style.removeProperty("--composition-shift");
    },
  };
}
