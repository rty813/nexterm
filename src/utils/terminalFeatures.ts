import type { IDisposable, Terminal } from "@xterm/xterm";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { AppSettings, ClipboardPermission, QuickCommand, TerminalOptions } from "../types/domain";
import { metaKeyOf } from "../types/domain";
import { backend } from "../services/backend";
import { commandHistory } from "./commandHistory";
import { InputTracker } from "./inputTracker";
import { OutputFolder, type FoldHost } from "./outputFold";
import { ScreenOverlay } from "./screenOverlay";
import { computeCandidates, commandOfInput, loadCatalog, loadOptions, type Candidate, type CatalogEntry, type CommandOption } from "./autoComplete";
import { autoCompleteOf, historyOf, mouseOf } from "./settingsDefaults";

export interface SuggestionState {
  items: Candidate[];
  selected: number;
  visibleRows: number;
  /** Popup position inside the pane's terminal mount, px. */
  left: number;
  top: number;
  /** Open upwards (no room below the cursor). */
  above: boolean;
  /** Height of one terminal row, px. */
  rowHeight: number;
}

/** What the terminal features need from the pane that hosts them. */
export interface FeatureContext {
  paneId: string;
  settings: () => AppSettings;
  termOptions: () => TerminalOptions;
  scheme: () => string;
  sessionLabel: () => string;
  /** historyKeyOf(the pane's session). */
  sessionKey: () => string;
  quickCommands: () => QuickCommand[];
  colors: () => { fg: string; bg: string };
  /** Send as if typed (key options + sync input apply). */
  sendInput: (data: string) => void;
  /** Reply to this pane's program only, untouched (OSC 52 answers). */
  sendRaw: (data: string) => void;
  /** Paste, going through the multi-line confirmation. */
  requestPaste: (text: string) => void;
  openMenu: (ev: MouseEvent) => void;
  /** Font zoom changed: refit the terminal. */
  refit: () => void;
  /** Ask about a remote clipboard access. "always": allow for the rest of this session. */
  confirmClipboard: (kind: "read" | "write", preview: string) => Promise<"no" | "once" | "always">;
  onSuggestions: (s: SuggestionState | null) => void;
  fold: Omit<FoldHost, "onRemap">;
}

export interface TerminalFeatures extends IDisposable {
  folder: OutputFolder;
  tracker: InputTracker;
  /** Custom key handler step: false = the key was handled here. */
  onKey: (ev: KeyboardEvent) => boolean;
  /** Custom wheel handler step: a boolean ends the handling, undefined = carry on. */
  onWheel: (ev: WheelEvent) => boolean | undefined;
  /** The program gets right clicks (mouse tracking): no context menu. */
  appOwnsRightClick: (ev: { shiftKey: boolean }) => boolean;
  acceptSuggestion: (index: number) => void;
  closeSuggestions: () => void;
  /** Settings or theme changed. `baseFontSize` = the font size before this pane's zoom. */
  update: (baseFontSize: number) => void;
  /** Whole buffer as plain text (wrapped rows joined). */
  plainText: () => string;
  /** Absolute buffer row under a mouse position. */
  rowAt: (clientY: number) => number | null;
  /**
   * A command entered without the keyboard (the MCP agent's run_command): command history
   * and the fold marker on the prompt line the cursor is on, as for a typed command.
   */
  recordCommand: (command: string) => void;
}

const MAX_SUGGESTIONS = 60;

function b64ToUtf8(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function utf8ToB64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function installTerminalFeatures(
  term: Terminal,
  mount: HTMLElement,
  serializer: SerializeAddon,
  foldGutter: HTMLDivElement,
  ctx: FeatureContext
): TerminalFeatures {
  const subs: IDisposable[] = [];
  const tracker = new InputTracker(term);
  subs.push(tracker);

  let fontZoom = 0;
  let baseFont = term.options.fontSize ?? 14;

  // ------------------------------------------------------------ folding + display
  const folder = new OutputFolder(term, serializer, foldGutter, {
    ...ctx.fold,
    onRemap: () => tracker.reset(),
  });
  subs.push(folder);
  const overlay = new ScreenOverlay(term, overlayOptions(), () => tracker.inputStart);
  subs.push(overlay);

  function overlayOptions() {
    const s = ctx.settings();
    const { fg, bg } = ctx.colors();
    return { alternateRows: Boolean(s.alternateRowColors), whitespace: s.showWhitespace ?? "none", fg, bg };
  }

  // ------------------------------------------------------------ history + completion
  let catalog: CatalogEntry[] = [];
  let catalogScheme = "";
  let options: CommandOption[] = [];
  let optionsFor = "";
  let suggestions: SuggestionState | null = null;
  let frame = 0;

  const emit = () => ctx.onSuggestions(suggestions ? { ...suggestions } : null);
  const closeSuggestions = () => {
    window.clearTimeout(frame);
    if (suggestions) {
      suggestions = null;
      emit();
    }
  };

  const ensureCatalog = () => {
    const scheme = ctx.scheme();
    if (scheme === catalogScheme) return;
    catalogScheme = scheme;
    void loadCatalog(scheme).then((list) => {
      if (catalogScheme === scheme) {
        catalog = list;
        refreshSoon();
      }
    });
  };

  const compute = () => {
    const cfg = autoCompleteOf(ctx.settings());
    const buf = term.buffer.active;
    if (!cfg.enabled || !tracker.typed || buf.type !== "normal" || document.activeElement !== term.textarea) {
      closeSuggestions();
      return;
    }
    if (!tracker.atLineEnd()) {
      closeSuggestions();
      return;
    }
    const input = tracker.read(true);
    if (input === null || !input.trim()) {
      closeSuggestions();
      return;
    }
    ensureCatalog();
    const token = /\s$/.test(input) ? "" : input.split(/\s+/).pop() ?? "";
    if (cfg.commandOptions && /\s/.test(input.trim()) && (token.startsWith("-") || token.startsWith("/"))) {
      const cmd = commandOfInput(input, catalog);
      if (cmd && cmd !== optionsFor) {
        optionsFor = cmd;
        options = [];
        void loadOptions(ctx.scheme(), cmd).then((list) => {
          if (optionsFor === cmd) {
            options = list;
            refreshSoon();
          }
        });
      }
    }
    const items = computeCandidates(
      input,
      {
        history:
          cfg.history && historyOf(ctx.settings()).enabled
            ? commandHistory.search(input, 40, historyOf(ctx.settings()).perSession ? ctx.sessionKey() : undefined)
            : [],
        quickCommands: ctx.quickCommands(),
        catalog,
        options,
      },
      cfg,
      MAX_SUGGESTIONS
    );
    if (!items.length) {
      closeSuggestions();
      return;
    }
    const screen = term.element?.querySelector(".xterm-screen") as HTMLElement | null;
    if (!screen) return;
    const sr = screen.getBoundingClientRect();
    const mr = mount.getBoundingClientRect();
    const cw = sr.width / term.cols;
    const rh = sr.height / term.rows;
    const visibleRows = Math.max(3, Math.min(20, cfg.visibleRows));
    const listHeight = Math.min(items.length, visibleRows) * 22 + 8;
    const cursorTop = sr.top - mr.top + buf.cursorY * rh;
    const above = cursorTop + rh + listHeight > mr.height && cursorTop > listHeight;
    const prevLabel = suggestions && suggestions.selected >= 0 ? suggestions.items[suggestions.selected]?.label : null;
    let selected = prevLabel ? items.findIndex((c) => c.label === prevLabel) : -1;
    if (selected < 0 && cfg.preselect) selected = 0;
    // Start the list at the input's first column, like WindTerm.
    const startCol = Math.max(0, buf.cursorX - input.length);
    suggestions = {
      items,
      selected,
      visibleRows,
      left: Math.min(sr.left - mr.left + startCol * cw, Math.max(0, mr.width - 360)),
      top: above ? cursorTop : cursorTop + rh,
      above,
      rowHeight: rh,
    };
    emit();
  };

  function refreshSoon() {
    window.clearTimeout(frame);
    frame = window.setTimeout(compute, 16);
  }

  const acceptSuggestion = (index: number) => {
    const item = suggestions?.items[index];
    if (!item) return;
    closeSuggestions();
    ctx.sendInput(item.insert);
    term.focus();
  };

  subs.push(
    term.onData((data) => {
      const done = tracker.input(data);
      if (done) {
        closeSuggestions();
        for (const d of done) {
          if (historyOf(ctx.settings()).enabled) commandHistory.add(d.command, ctx.sessionLabel(), ctx.sessionKey());
          if (d.line >= 0) folder.markCommand(d.line);
        }
        return;
      }
      if (suggestions || tracker.typed) refreshSoon();
      else closeSuggestions();
    }),
    term.onWriteParsed(() => {
      if (tracker.typed) refreshSoon();
    }),
    term.onCursorMove(() => {
      if (suggestions) refreshSoon();
    }),
    term.buffer.onBufferChange(() => closeSuggestions())
  );
  const onBlur = () => window.setTimeout(() => {
    // Clicking the popup keeps it (it takes no focus).
    if (document.activeElement !== term.textarea) closeSuggestions();
  }, 120);
  term.textarea?.addEventListener("blur", onBlur);

  // ------------------------------------------------------------ keys
  let altSide: "left" | "right" | null = null;

  const consume = (ev: KeyboardEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    return false;
  };

  const onKey = (ev: KeyboardEvent): boolean => {
    if (ev.code === "AltLeft" || ev.code === "AltRight") {
      altSide = ev.type === "keydown" ? (ev.code === "AltLeft" ? "left" : "right") : null;
      return true;
    }
    if (ev.type !== "keydown") return true;

    // Suggestion list navigation.
    const plain = !ev.ctrlKey && !ev.altKey && !ev.metaKey;
    if (suggestions && plain) {
      const n = suggestions.items.length;
      switch (ev.key) {
        case "ArrowDown":
          suggestions.selected = (suggestions.selected + 1) % n;
          emit();
          return consume(ev);
        case "ArrowUp":
          if (suggestions.selected <= 0) {
            // Nothing picked: Up goes to the shell (its own history).
            closeSuggestions();
            return true;
          }
          suggestions.selected -= 1;
          emit();
          return consume(ev);
        case "PageDown":
          suggestions.selected = Math.min(n - 1, Math.max(0, suggestions.selected) + suggestions.visibleRows);
          emit();
          return consume(ev);
        case "PageUp":
          suggestions.selected = Math.max(0, suggestions.selected - suggestions.visibleRows);
          emit();
          return consume(ev);
        case "Tab":
        case "Enter":
          if (suggestions.selected >= 0) {
            acceptSuggestion(suggestions.selected);
            return consume(ev);
          }
          closeSuggestions();
          return true;
        case "Escape":
          closeSuggestions();
          return consume(ev);
        default:
          break;
      }
    }

    // Meta key mapping (WindTerm terminal.metaModifierKey).
    const meta = metaKeyOf(ctx.termOptions());
    if (ev.altKey && !ev.ctrlKey && !ev.metaKey && ev.key.length === 1) {
      const side = altSide ?? "left";
      const isMeta = meta === "alt" || (meta === "leftAlt" && side === "left") || (meta === "rightAlt" && side === "right");
      if (!isMeta) {
        ctx.sendInput(ev.key);
        return consume(ev);
      }
    }
    if (meta === "win" && ev.metaKey && !ev.ctrlKey && !ev.altKey && ev.key.length === 1) {
      ctx.sendInput(`\x1b${ev.key}`);
      return consume(ev);
    }
    return true;
  };

  // ------------------------------------------------------------ mouse
  const tracking = () => term.modes.mouseTrackingMode !== "none";
  const synthetic = new WeakSet<Event>();

  /** Hand a mouse event back to xterm as Shift+click: local selection despite tracking. */
  const forwardLocal = (ev: MouseEvent) => {
    const clone = new MouseEvent(ev.type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      detail: ev.detail,
      screenX: ev.screenX,
      screenY: ev.screenY,
      clientX: ev.clientX,
      clientY: ev.clientY,
      button: ev.button,
      buttons: ev.buttons,
      ctrlKey: ev.ctrlKey,
      altKey: ev.altKey,
      metaKey: ev.metaKey,
      shiftKey: true,
    });
    synthetic.add(clone);
    ev.target?.dispatchEvent(clone);
  };

  const rowAt = (clientY: number): number | null => {
    const screen = term.element?.querySelector(".xterm-screen") as HTMLElement | null;
    if (!screen) return null;
    const r = screen.getBoundingClientRect();
    const row = Math.floor(((clientY - r.top) / r.height) * term.rows);
    if (row < 0 || row >= term.rows) return null;
    return term.buffer.active.viewportY + row;
  };

  const onMouseDown = (ev: MouseEvent) => {
    if (synthetic.has(ev)) return;
    const m = mouseOf(ctx.settings());
    const appWants = tracking() && !ev.shiftKey;
    if (ev.button === 1) {
      if (appWants && m.tracking.middleClick) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (m.middleClick === "paste") void backend.readClipboard().then((text) => text && ctx.requestPaste(text));
      else if (m.middleClick === "pasteSelection") {
        const sel = term.getSelection();
        if (sel) ctx.requestPaste(sel);
      } else if (m.middleClick === "menu") ctx.openMenu(ev);
      return;
    }
    if (ev.button === 2) {
      // Kept local: the context menu (contextmenu event) handles it.
      if (appWants && !m.tracking.rightClick) ev.stopPropagation();
      return;
    }
    if (ev.button !== 0) return;
    const double = ev.detail === 2;
    if (appWants) {
      if (double ? m.tracking.doubleClick : m.tracking.click) return;
      ev.preventDefault();
      ev.stopPropagation();
      forwardLocal(ev);
      return;
    }
    if (double && m.doubleClick !== "word") {
      if (m.doubleClick === "none") {
        ev.preventDefault();
        ev.stopPropagation();
      } else if (m.doubleClick === "line") {
        ev.preventDefault();
        ev.stopPropagation();
        const row = rowAt(ev.clientY);
        if (row !== null) term.selectLines(row, row);
      } else if (m.doubleClick === "wordCopy") {
        window.addEventListener(
          "mouseup",
          () => window.setTimeout(() => term.hasSelection() && void backend.writeClipboard(term.getSelection()), 0),
          { once: true }
        );
      }
    }
  };
  const onMouseMove = (ev: MouseEvent) => {
    if (synthetic.has(ev) || ev.buttons !== 0) return;
    if (tracking() && !mouseOf(ctx.settings()).tracking.move) ev.stopPropagation();
  };
  mount.addEventListener("mousedown", onMouseDown, true);
  mount.addEventListener("mousemove", onMouseMove, true);

  // Paste (Ctrl+V / Shift+Insert / the browser menu) goes through the confirmation.
  const onPaste = (ev: ClipboardEvent) => {
    const text = ev.clipboardData?.getData("text/plain") ?? "";
    ev.preventDefault();
    ev.stopPropagation();
    if (text) ctx.requestPaste(text);
  };
  mount.addEventListener("paste", onPaste, true);

  let wheelZoomAcc = 0;
  const onWheel = (ev: WheelEvent): boolean | undefined => {
    const m = mouseOf(ctx.settings());
    if (ev.ctrlKey && m.ctrlWheelZoom && ev.deltaY !== 0) {
      wheelZoomAcc += ev.deltaY;
      if (Math.abs(wheelZoomAcc) >= 50) {
        const step = wheelZoomAcc < 0 ? 1 : -1;
        wheelZoomAcc = 0;
        const next = Math.max(6, Math.min(48, baseFont + fontZoom + step));
        fontZoom = next - baseFont;
        term.options.fontSize = next;
        ctx.refit();
      }
      ev.preventDefault();
      return false;
    }
    if (tracking() && !m.tracking.wheel && !ev.shiftKey && ev.deltaY !== 0 && term.buffer.active.type === "normal") {
      const per = Math.max(1, ctx.settings().wheelScrollLines ?? 3);
      term.scrollLines(Math.sign(ev.deltaY) * per);
      ev.preventDefault();
      return false;
    }
    return undefined;
  };

  // ------------------------------------------------------------ OSC 52 clipboard
  const remembered: { read?: boolean; write?: boolean } = {};
  const allowed = async (kind: "read" | "write", preview: string): Promise<boolean> => {
    const s = ctx.settings();
    const perm: ClipboardPermission = (kind === "write" ? s.remoteClipboardWrite : s.remoteClipboardRead) ?? (kind === "write" ? "allow" : "ask");
    if (perm === "deny") return false;
    if (perm === "allow" || remembered[kind]) return true;
    const answer = await ctx.confirmClipboard(kind, preview);
    if (answer === "always") remembered[kind] = true;
    return answer !== "no";
  };
  subs.push(
    term.parser.registerOscHandler(52, (data) => {
      const semi = data.indexOf(";");
      if (semi < 0) return true;
      const target = data.slice(0, semi) || "c";
      const payload = data.slice(semi + 1);
      if (payload === "?") {
        void allowed("read", "").then(async (ok) => {
          if (!ok) return;
          const text = await backend.readClipboard();
          ctx.sendRaw(`\x1b]52;${target};${utf8ToB64(text)}\x07`);
        });
        return true;
      }
      let text = "";
      try {
        text = b64ToUtf8(payload);
      } catch {
        return true;
      }
      void allowed("write", text).then((ok) => ok && void backend.writeClipboard(text));
      return true;
    })
  );

  // ------------------------------------------------------------ misc
  const plainText = (): string => {
    const buf = term.buffer.active;
    const lines: string[] = [];
    let current = "";
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const next = buf.getLine(y + 1);
      const wraps = Boolean(next?.isWrapped);
      current += line.translateToString(!wraps);
      if (!wraps) {
        lines.push(current);
        current = "";
      }
    }
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n") + "\n";
  };

  const update = (baseFontSize: number) => {
    baseFont = baseFontSize;
    if (fontZoom) term.options.fontSize = Math.max(6, Math.min(48, baseFont + fontZoom));
    overlay.update(overlayOptions());
    const s = ctx.settings();
    folder.setVisible(s.foldMargin !== false, Boolean(s.showWrapMarks));
    if (!autoCompleteOf(s).enabled) closeSuggestions();
  };
  update(baseFont);

  return {
    folder,
    tracker,
    onKey,
    onWheel,
    appOwnsRightClick: (ev) => tracking() && !ev.shiftKey && mouseOf(ctx.settings()).tracking.rightClick,
    acceptSuggestion,
    closeSuggestions,
    update,
    plainText,
    rowAt,
    recordCommand: (command) => {
      const cmd = command.trim();
      if (!cmd) return;
      if (historyOf(ctx.settings()).enabled) commandHistory.add(cmd, ctx.sessionLabel(), ctx.sessionKey());
      if (term.buffer.active.type === "normal") folder.markCommand(term.buffer.active.baseY + term.buffer.active.cursorY);
    },
    dispose: () => {
      window.clearTimeout(frame);
      term.textarea?.removeEventListener("blur", onBlur);
      mount.removeEventListener("mousedown", onMouseDown, true);
      mount.removeEventListener("mousemove", onMouseMove, true);
      mount.removeEventListener("paste", onPaste, true);
      subs.forEach((s) => s.dispose());
    },
  };
}
