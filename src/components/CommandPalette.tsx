import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Command, History, Search, SquareTerminal } from "lucide-react";
import type { ProtocolType, SessionConfig } from "../types/domain";
import { bestScore } from "../utils/fuzzy";
import { looksLikeAddress, parseQuickConnectInput } from "../utils/quickConnect";
import { sessionTargetSummary } from "../utils/sessionSummary";
import { ProtocolBadge } from "./ProtocolBadge";
import { useGitBashFound } from "../hooks/useGitBash";

export interface PaletteTab {
  paneId: string;
  title: string;
  protocol: ProtocolType;
  detail: string;
}

/** A session listed by a plugin's session source (e.g. a bastion host). */
export interface PalettePluginSession {
  pluginId: string;
  sourceId: string;
  itemId: string;
  label: string;
  /** Source title, group and description, shown dimmed. */
  detail: string;
  /** Searched besides the label. */
  keywords: string[];
}

export interface PaletteAction {
  id: string;
  label: string;
  shortcut?: string;
}

interface CommandPaletteProps {
  actions: PaletteAction[];
  sessions: SessionConfig[];
  /** Sessions from plugin session sources; listed only while searching. */
  pluginSessions: PalettePluginSession[];
  /** Saved session ids, most recently used first. */
  recentSessionIds: string[];
  tabs: PaletteTab[];
  quickHistory: string[];
  onRunAction: (id: string) => void;
  onOpenSession: (session: SessionConfig) => void;
  onOpenPluginSession: (session: PalettePluginSession) => void;
  onFocusTab: (paneId: string) => void;
  onOpenShell: (protocol: ProtocolType) => void;
  onQuickConnect: (raw: string) => void;
  /** `ran`: an item was run (it takes the focus); otherwise the palette was dismissed. */
  onClose: (ran: boolean) => void;
}

type Section = "connect" | "tabs" | "sessions" | "shells" | "actions";

interface Item {
  key: string;
  section: Section;
  label: string;
  detail?: string;
  shortcut?: string;
  icon: React.ReactNode;
  score: number;
  run: () => void;
}

const SHELLS: ProtocolType[] = ["powershell", "cmd", "wsl", "gitbash"];
const LIMIT: Record<Section, number> = { connect: 1, tabs: 8, sessions: 8, shells: 4, actions: 40 };

/**
 * One box for everything: switch to an open tab, open a saved session, start a shell,
 * connect to an address typed as in quick connect, or run any command. Typing ">"
 * first lists commands only.
 */
export const CommandPalette: React.FC<CommandPaletteProps> = ({
  actions,
  sessions,
  pluginSessions,
  recentSessionIds,
  tabs,
  quickHistory,
  onRunAction,
  onOpenSession,
  onOpenPluginSession,
  onFocusTab,
  onOpenShell,
  onQuickConnect,
  onClose,
}) => {
  const { t } = useTranslation();
  const gitBashFound = useGitBashFound();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const items = useMemo<Item[]>(() => {
    const commandsOnly = query.startsWith(">");
    const q = (commandsOnly ? query.slice(1) : query).trim();
    const out: Item[] = [];
    const push = (section: Section, item: Omit<Item, "section" | "score">, fields: (string | undefined)[], boost = 0) => {
      const sc = q ? bestScore(q, fields) : 0;
      if (sc === null) return;
      out.push({ ...item, section, score: sc + boost });
    };
    const done = (fn: () => void) => () => {
      onClose(true);
      fn();
    };

    if (!commandsOnly) {
      // An address typed as in the quick connect bar.
      if (looksLikeAddress(q) && parseQuickConnectInput(q)) {
        out.push({
          key: "connect",
          section: "connect",
          label: t("palette.connectTo", { target: q }),
          icon: <ArrowRight size={14} />,
          score: Infinity,
          run: done(() => onQuickConnect(q)),
        });
      }
      for (const tab of tabs) {
        push("tabs", { key: `tab-${tab.paneId}`, label: tab.title, detail: tab.detail, icon: <ProtocolBadge protocol={tab.protocol} size={14} />, run: done(() => onFocusTab(tab.paneId)) }, [tab.title, tab.detail]);
      }
      const recentRank = new Map(recentSessionIds.map((id, i) => [id, i]));
      const ordered = q
        ? sessions
        : [...sessions].filter((s) => recentRank.has(s.id)).sort((a, b) => recentRank.get(a.id)! - recentRank.get(b.id)!);
      for (const s of ordered) {
        const detail = [s.group, sessionTargetSummary(s)].filter(Boolean).join("  ");
        const boost = recentRank.has(s.id) ? 1 - recentRank.get(s.id)! / 100 : 0;
        push("sessions", { key: `s-${s.id}`, label: s.label, detail, icon: <ProtocolBadge protocol={s.protocol} size={14} />, run: done(() => onOpenSession(s)) }, [s.label, s.host, s.group, s.username], boost);
      }
      if (q) {
        for (const p of pluginSessions) {
          push("sessions", { key: `ps-${p.pluginId}:${p.sourceId}:${p.itemId}`, label: p.label, detail: p.detail, icon: <ProtocolBadge protocol="ssh" size={14} />, run: done(() => onOpenPluginSession(p)) }, [p.label, ...p.keywords]);
        }
      } else {
        for (const raw of quickHistory.slice(0, 5)) {
          out.push({ key: `qh-${raw}`, section: "sessions", label: raw, detail: t("palette.recentQuick"), icon: <History size={14} />, score: -1, run: done(() => onQuickConnect(raw)) });
        }
      }
      for (const p of SHELLS) {
        if (p === "gitbash" && !gitBashFound) continue;
        const label = t(`palette.newShell.${p}`);
        push("shells", { key: `sh-${p}`, label, icon: <ProtocolBadge protocol={p} size={14} />, run: done(() => onOpenShell(p)) }, [label, p]);
      }
    }
    for (const a of actions) {
      push("actions", { key: `a-${a.id}`, label: a.label, shortcut: a.shortcut, icon: <Command size={13} />, run: done(() => onRunAction(a.id)) }, [a.label, a.id]);
    }

    // Keep the section order; inside a section, best match first.
    const order: Section[] = ["connect", "tabs", "sessions", "shells", "actions"];
    return order.flatMap((sec) => {
      const list = out.filter((i) => i.section === sec);
      if (q) list.sort((a, b) => b.score - a.score);
      return list.slice(0, q || sec !== "actions" ? LIMIT[sec] : LIMIT.actions);
    });
  }, [query, actions, sessions, pluginSessions, recentSessionIds, tabs, quickHistory, t, onClose, onQuickConnect, onFocusTab, onOpenSession, onOpenPluginSession, onOpenShell, onRunAction, gitBashFound]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      setIndex((i) => (items.length ? (i + 1) % items.length : 0));
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      setIndex((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[index]?.run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose(false);
    }
  };

  let lastSection: Section | null = null;
  return (
    <div className="palette-backdrop" onMouseDown={() => onClose(false)}>
      <div className="palette" role="dialog" aria-label={t("palette.title")} onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Search size={15} />
          <input
            autoFocus
            value={query}
            placeholder={t("palette.placeholder")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[index] ? `palette-item-${index}` : undefined}
          />
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {items.length === 0 && (
            <div className="palette-empty">
              <SquareTerminal size={16} />
              {t("palette.empty")}
            </div>
          )}
          {items.map((item, i) => {
            const header = item.section !== lastSection ? item.section : null;
            lastSection = item.section;
            return (
              <React.Fragment key={item.key}>
                {header && header !== "connect" && <div className="palette-section">{t(`palette.section.${header}`)}</div>}
                <div
                  id={`palette-item-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === index}
                  className={`palette-item ${i === index ? "selected" : ""}`}
                  onMouseMove={() => i !== index && setIndex(i)}
                  onClick={item.run}
                >
                  <span className="palette-icon">{item.icon}</span>
                  <span className="palette-label">{item.label}</span>
                  {item.detail && <span className="palette-detail">{item.detail}</span>}
                  {item.shortcut && <kbd className="palette-kbd">{item.shortcut}</kbd>}
                </div>
              </React.Fragment>
            );
          })}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> {t("palette.hintMove")}
          </span>
          <span>
            <kbd>Enter</kbd> {t("palette.hintRun")}
          </span>
          <span>
            <kbd>&gt;</kbd> {t("palette.hintCommands")}
          </span>
        </div>
      </div>
    </div>
  );
};
