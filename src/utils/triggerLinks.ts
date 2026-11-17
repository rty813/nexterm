import type { IDisposable, ILink, ILinkHandler, Terminal } from "@xterm/xterm";
import { logicalLineAt } from "./textMatch";
import {
  activationMatches,
  effectHint,
  findTriggerHits,
  linkEffect,
  sanitizeTooltip,
  type CompiledTrigger,
  type TriggerContext,
  type TriggerEffect,
  type TriggerHit,
  underlineMarks,
  type UnderlineMark,
} from "./triggers";

export interface TriggerLinkOptions {
  triggers: () => CompiledTrigger[];
  context: () => TriggerContext;
  /** Carry out a clicked match (open, connect, reveal, type). */
  run: (effect: TriggerEffect) => void;
  /** Run a tooltip script (sandboxed); null = no tooltip, undefined = not answered (ask again). */
  runScript: (source: string, captures: Record<string, string>) => Promise<string | null | undefined>;
  /** Underline every match on screen, so it is clear what can be hovered / clicked. */
  underline: () => boolean;
  underlineColor: () => string;
}

export interface TriggerLinks extends IDisposable {
  /** For term.options.linkHandler: OSC 8 links follow the Hyperlink trigger. */
  oscLinkHandler: ILinkHandler;
  /** Repaint the underlines (triggers, colors or the underline setting changed). */
  refresh: () => void;
}

/** Tooltip script results by source and captures, shared by every pane (null = no tooltip). */
const scriptResults = new Map<string, string | null>();
const MAX_SCRIPT_RESULTS = 2000;
const scriptKey = (source: string, captures: Record<string, string>) => `${source}\u0000${JSON.stringify(captures)}`;

/** Lines whose underlines are remembered per pane (by text). */
const MAX_LINE_MARKS = 1000;

/**
 * Triggers in an xterm: matches become links (hover = tooltip, click = action),
 * found on the logical line under the mouse so they may span wrapped rows.
 */
export function installTriggerLinks(term: Terminal, o: TriggerLinkOptions): TriggerLinks {
  let tip: HTMLDivElement | null = null;
  /** Bumped on every hover / leave, so a late script result is dropped. */
  let hoverSeq = 0;

  const hide = () => {
    hoverSeq++;
    if (tip) tip.style.display = "none";
  };

  const show = (ev: MouseEvent, html: string, hint: string | null) => {
    const host = term.element;
    if (!host || (!html && !hint)) return;
    if (!tip) {
      tip = document.createElement("div");
      // xterm-hover: the mouse over the tooltip does not reach the links below it.
      tip.className = "trigger-tip xterm-hover";
      host.appendChild(tip);
    }
    tip.innerHTML = `${html ? `<div class="trigger-tip-body">${html}</div>` : ""}${
      hint ? `<div class="trigger-tip-hint">${sanitizeTooltip(hint.replace(/</g, "‹"))}</div>` : ""
    }`;
    tip.style.display = "block";
    const rect = host.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    tip.style.left = `${Math.max(2, Math.min(x + 12, rect.width - w - 4))}px`;
    tip.style.top = `${y + 20 + h > rect.height ? Math.max(2, y - h - 10) : y + 20}px`;
  };

  /** Run a script once per source + captures; results are cached. */
  const running = new Set<string>();
  const runScript = (source: string, captures: Record<string, string>): Promise<string | null | undefined> => {
    const key = scriptKey(source, captures);
    running.add(key);
    return o.runScript(source, captures).then((text) => {
      running.delete(key);
      if (text !== undefined) {
        if (scriptResults.size >= MAX_SCRIPT_RESULTS) scriptResults.clear();
        scriptResults.set(key, text);
      }
      return text;
    });
  };

  const hoverHit = (ev: MouseEvent, hit: TriggerHit) => {
    const seq = ++hoverSeq;
    const tipSrc = hit.tip;
    if (tipSrc && "script" in tipSrc) {
      const known = scriptResults.get(scriptKey(tipSrc.script, hit.captures));
      if (known !== undefined) {
        show(ev, known ? sanitizeTooltip(known) : "", hit.hint);
        return;
      }
      // Show the action hint now; the script's text joins it when it answers.
      if (hit.hint) show(ev, "", hit.hint);
      void runScript(tipSrc.script, hit.captures).then((text) => {
        if (seq !== hoverSeq) return;
        if (text) show(ev, sanitizeTooltip(text), hit.hint);
      });
      return;
    }
    show(ev, tipSrc?.html ?? "", hit.hint);
  };

  const provider = term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const triggers = o.triggers();
      const row = bufferLineNumber - 1;
      const line = triggers.length ? logicalLineAt(term, row) : null;
      if (!line || !line.text.trim()) return callback(undefined);
      const buf = term.buffer.active;
      const links: ILink[] = [];
      for (const hit of findTriggerHits(line.text, triggers, o.context())) {
        const first = line.pos[hit.start];
        const last = line.pos[hit.end - 1];
        if (!first || !last || first.row > row || last.row < row) continue;
        const width = buf.getLine(last.row)?.getCell(last.col)?.getWidth() || 1;
        const effect = hit.effect;
        links.push({
          range: { start: { x: first.col + 1, y: first.row + 1 }, end: { x: last.col + width, y: last.row + 1 } },
          text: hit.text,
          // Only clickable matches get the hand cursor; the underline layer marks them all
          // (xterm's own hover underline only when that layer is off).
          decorations: { pointerCursor: Boolean(effect), underline: Boolean(effect) && !o.underline() },
          activate: (ev) => {
            if (!effect || !activationMatches(hit.rule.activation, ev)) return;
            ev.preventDefault();
            hide();
            o.run(effect);
          },
          hover: (ev) => hoverHit(ev, hit),
          leave: hide,
        });
      }
      callback(links.length ? links : undefined);
    },
  });

  const hyperlinkRule = () => o.triggers().find((t) => t.rule.builtin === "hyperlink")?.rule ?? null;
  const oscLinkHandler: ILinkHandler = {
    // Non-http links (file://, ssh:// ...) are vetted by linkEffect.
    allowNonHttpProtocols: true,
    activate: (ev, uri) => {
      const rule = hyperlinkRule();
      const effect = rule ? linkEffect(uri) : null;
      if (!rule || !effect || !activationMatches(rule.activation, ev)) return;
      ev.preventDefault();
      hide();
      o.run(effect);
    },
    hover: (ev, uri) => {
      const rule = hyperlinkRule();
      const effect = rule ? linkEffect(uri) : null;
      if (!rule || !effect) return;
      hoverSeq++;
      // The target, which an OSC 8 link's text need not show.
      show(ev, sanitizeTooltip(uri.replace(/</g, "‹")), effectHint(effect, rule.activation ?? "ctrlClick", o.context().t));
    },
    leave: hide,
  };

  // ---- Underlines: every match in the viewport, solid when clicking does something,
  // dotted when it only has a tooltip. Drawn on a canvas over the screen, so the text
  // and its colors stay the program's.
  let canvas: HTMLCanvasElement | null = null;
  let frame = 0;
  const lineMarks = new Map<string, UnderlineMark[]>();
  let marksFor: CompiledTrigger[] | null = null;
  let marksScheme = "";

  const marksOf = (text: string, triggers: CompiledTrigger[], ctx: TriggerContext): UnderlineMark[] => {
    if (triggers !== marksFor || ctx.scheme !== marksScheme) {
      lineMarks.clear();
      marksFor = triggers;
      marksScheme = ctx.scheme;
    }
    const known = lineMarks.get(text);
    if (known) return known;
    let waiting = false;
    const marks = underlineMarks(findTriggerHits(text, triggers, ctx), (source, captures) => {
      const key = scriptKey(source, captures);
      const r = scriptResults.get(key);
      if (r !== undefined) return r !== null;
      // Not known yet: underline once the script has answered with a tooltip.
      waiting = true;
      if (!running.has(key)) void runScript(source, captures).then(() => schedule());
      return false;
    });
    if (!waiting) {
      if (lineMarks.size >= MAX_LINE_MARKS) lineMarks.clear();
      lineMarks.set(text, marks);
    }
    return marks;
  };

  const paint = () => {
    const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
    const triggers = o.triggers();
    if (!screen || !o.underline() || triggers.length === 0) {
      canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.className = "trigger-underlines";
      screen.appendChild(canvas);
    }
    const dpr = window.devicePixelRatio || 1;
    const w = screen.clientWidth;
    const h = screen.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const g = canvas.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const cw = w / term.cols;
    const ch = h / term.rows;
    const ctx = o.context();
    const buf = term.buffer.active;
    const top = buf.viewportY;
    const bottom = top + term.rows;
    /** [screen row, first cell, end cell] per stroke. */
    const solid: number[][] = [];
    const dotted: number[][] = [];
    let y = top;
    while (y < bottom) {
      const line = logicalLineAt(term, y);
      let next = y + 1;
      while (next < bottom && buf.getLine(next)?.isWrapped) next++;
      if (line && line.text.trim()) {
        for (const m of marksOf(line.text, triggers, ctx)) {
          // One stroke per screen row the match covers.
          let seg: [number, number, number] | null = null;
          const flush = () => {
            if (seg && seg[0] >= top && seg[0] < bottom) (m.solid ? solid : dotted).push([seg[0] - top, seg[1], seg[2]]);
          };
          for (let i = m.start; i < m.end; i++) {
            const p = line.pos[i];
            if (!p) continue;
            const width = buf.getLine(p.row)?.getCell(p.col)?.getWidth() || 1;
            if (seg && seg[0] === p.row) seg[2] = Math.max(seg[2], p.col + width);
            else {
              flush();
              seg = [p.row, p.col, p.col + width];
            }
          }
          flush();
        }
      }
      y = next;
    }
    g.strokeStyle = o.underlineColor();
    g.lineWidth = 1;
    const stroke = (segs: number[][], dash: number[]) => {
      if (!segs.length) return;
      g.setLineDash(dash);
      g.beginPath();
      for (const [row, from, to] of segs) {
        const ly = Math.round((row + 1) * ch) - 0.5;
        g.moveTo(Math.round(from * cw), ly);
        g.lineTo(Math.round(to * cw), ly);
      }
      g.stroke();
    };
    stroke(solid, []);
    stroke(dotted, [2, 2]);
  };

  const schedule = () => {
    // Called on every rendered frame while output streams: keep the frame already requested.
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      paint();
    });
  };
  const renderDisp = term.onRender(schedule);
  const resizeDisp = term.onResize(schedule);
  const bufferDisp = term.buffer.onBufferChange(schedule);
  schedule();

  // A click, a key or scrolling ends the hover.
  const el = term.element;
  el?.addEventListener("mousedown", hide, true);
  el?.addEventListener("wheel", hide, { capture: true, passive: true });
  const keyDisp = term.onKey(hide);
  const scrollDisp = term.onScroll(hide);

  return {
    oscLinkHandler,
    refresh: () => {
      lineMarks.clear();
      schedule();
    },
    dispose: () => {
      cancelAnimationFrame(frame);
      renderDisp.dispose();
      resizeDisp.dispose();
      bufferDisp.dispose();
      canvas?.remove();
      canvas = null;
      provider.dispose();
      keyDisp.dispose();
      scrollDisp.dispose();
      el?.removeEventListener("mousedown", hide, true);
      el?.removeEventListener("wheel", hide, true);
      tip?.remove();
      tip = null;
    },
  };
}
