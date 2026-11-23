import React, { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Cpu, Download, Plus, SquareTerminal, Terminal } from "lucide-react";
import type {
  AppSettings,
  LayoutNode,
  PaneGroup,
  ProtocolType,
  SplitDirection,
  TerminalLeafNode,
  ThemeDefinition,
} from "../types/domain";
import { TerminalPane } from "./TerminalPane";
import { DesktopPane } from "./DesktopPane";
import { isDesktopProtocol } from "../types/domain";
import type { PaneExtras, ReconnectCredentials } from "./TerminalPane";
import { GroupTabBar, SESSION_MIME, TAB_MIME, type GroupTabBarProps } from "./TabBar";
import type { DropHint } from "../utils/dropZones";
import type { MenuItem } from "./ContextMenu";

/** Position inside the workspace stage, in percent. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface GroupSlot {
  group: PaneGroup;
  rect: Rect;
}

interface DividerSlot {
  splitId: string;
  horizontal: boolean;
  parent: Rect;
  ratio: number;
}

function layoutTree(node: LayoutNode, rect: Rect, groups: GroupSlot[], dividers: DividerSlot[]): void {
  if (node.kind === "group") {
    groups.push({ group: node, rect });
    return;
  }
  const horizontal = node.direction === "horizontal";
  const r = Math.min(0.9, Math.max(0.1, node.ratio));
  const first: Rect = horizontal
    ? { x: rect.x, y: rect.y, w: rect.w * r, h: rect.h }
    : { x: rect.x, y: rect.y, w: rect.w, h: rect.h * r };
  const second: Rect = horizontal
    ? { x: rect.x + rect.w * r, y: rect.y, w: rect.w * (1 - r), h: rect.h }
    : { x: rect.x, y: rect.y + rect.h * r, w: rect.w, h: rect.h * (1 - r) };
  dividers.push({ splitId: node.id, horizontal, parent: rect, ratio: r });
  layoutTree(node.first, first, groups, dividers);
  layoutTree(node.second, second, groups, dividers);
}

const GAP = 4; // px on each side of a divider: the gutter between group panels
export const TABBAR_H = 34;

/** Absolute box for a group rect, inset next to dividers and optionally below its tab bar. */
function boxStyle(rect: Rect, topOffset = 0, height?: number): React.CSSProperties {
  const edge = (v: number) => v > 0.001;
  const left = edge(rect.x) ? GAP : 0;
  const right = edge(100 - rect.x - rect.w) ? GAP : 0;
  const top = edge(rect.y) ? GAP : 0;
  const bottom = edge(100 - rect.y - rect.h) ? GAP : 0;
  return {
    position: "absolute",
    left: `calc(${rect.x}% + ${left}px)`,
    top: `calc(${rect.y}% + ${top + topOffset}px)`,
    width: `calc(${rect.w}% - ${left + right}px)`,
    height: height !== undefined ? `${height}px` : `calc(${rect.h}% - ${top + bottom + topOffset}px)`,
  };
}

function dividerStyle(d: DividerSlot): React.CSSProperties {
  const p = d.parent;
  return d.horizontal
    ? {
        position: "absolute",
        left: `calc(${p.x + p.w * d.ratio}% - ${GAP}px)`,
        top: `${p.y}%`,
        width: `${GAP * 2}px`,
        height: `${p.h}%`,
      }
    : {
        position: "absolute",
        left: `${p.x}%`,
        top: `calc(${p.y + p.h * d.ratio}% - ${GAP}px)`,
        width: `${p.w}%`,
        height: `${GAP * 2}px`,
      };
}

/** Group-level actions, bound per group by the workspace. */
export type GroupActions = Omit<
  GroupTabBarProps,
  | "group"
  | "isActiveGroup"
  | "syncChannels"
  | "logPaths"
  | "tabMarks"
  | "agentStates"
  | "commandWatches"
  | "onActivateGroup"
  | "onPaneSettings"
  | "onSplitGroup"
  | "onDropTab"
  | "keymap"
  | "reuseSshConnection"
  | "tabMouse"
  | "hoverSwitch"
  | "onNewTab"
  | "newTabMenu"
  | "sessionMenu"
> & {
  onNewTab: (groupId: string) => void;
  newTabMenu: (groupId: string) => MenuItem[];
  sessionMenu: (groupId: string) => MenuItem[];
  onActivateGroup: (groupId: string) => void;
  onSplitGroup: (groupId: string, direction: SplitDirection) => void;
  onDropTab: (paneId: string, groupId: string, index: number) => void;
};

interface SplitWorkspaceProps {
  root: LayoutNode | null;
  activeGroupId: string | null;
  /** Group shown alone (maximized), or null. */
  zoomedGroupId: string | null;
  focusMode: boolean;
  theme: ThemeDefinition;
  settings: AppSettings;
  extras: PaneExtras;
  groupActions: GroupActions;
  /** Badge text per pane while its input is broadcast ("同步 A", ...). */
  syncBadges: Record<string, string>;
  onActivatePane: (paneId: string) => void;
  onUserInput: (paneId: string, data: string) => void;
  onDimensionsChange: (paneId: string, cols: number, rows: number) => void;
  onSplitPane: (paneId: string, direction: SplitDirection) => void;
  onClosePane: (paneId: string) => void;
  onReconnectPane: (paneId: string, creds?: ReconnectCredentials) => void;
  onResizeSplit: (splitId: string, ratio: number) => void;
  onQuickShell: (proto: ProtocolType) => void;
  onOpenNewSessionModal: () => void;
  onOpenImportModal: () => void;
  /** Preview of where a dragged tab / window would land. */
  dropHint: DropHint | null;
  /** A tab is dragged over the terminals (null: left the workspace or over a tab bar). */
  onTabDragOver: (point: { x: number; y: number } | null) => void;
  onTabDrop: (paneId: string, x: number, y: number) => void;
  /** A sidebar session dropped on the terminals: open it at that zone. */
  onSessionDrop: (sessionId: string, x: number, y: number) => void;
  /** Hide the welcome card (secondary windows). */
  hideWelcome?: boolean;
}

export const SplitWorkspace: React.FC<SplitWorkspaceProps> = ({
  root,
  activeGroupId,
  zoomedGroupId,
  focusMode,
  theme,
  settings,
  extras,
  groupActions,
  syncBadges,
  onActivatePane,
  onUserInput,
  onDimensionsChange,
  onSplitPane,
  onClosePane,
  onReconnectPane,
  onResizeSplit,
  onQuickShell,
  onOpenNewSessionModal,
  onOpenImportModal,
  dropHint,
  onTabDragOver,
  onTabDrop,
  onSessionDrop,
  hideWelcome,
}) => {
  const { t } = useTranslation();
  const stageRef = useRef<HTMLDivElement | null>(null);

  // A tab dragged over the terminals (of this or another window): split or join a group.
  // A session from the sidebar gets the same zones and opens there.
  const dragKind = (e: React.DragEvent) =>
    e.dataTransfer.types.includes(TAB_MIME) ? "tab" : e.dataTransfer.types.includes(SESSION_MIME) ? "session" : null;
  const dropHandlers = {
    onDragOver: (e: React.DragEvent) => {
      const kind = dragKind(e);
      if (!kind) return;
      if (kind === "tab" && (e.target as HTMLElement).closest?.(".group-tabbar")) {
        onTabDragOver(null); // the tab bar places it between tabs itself
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = kind === "tab" ? "move" : "copy";
      onTabDragOver({ x: e.clientX, y: e.clientY });
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onTabDragOver(null);
    },
    onDrop: (e: React.DragEvent) => {
      const kind = dragKind(e);
      if (!kind) return;
      e.preventDefault();
      if (kind === "tab") onTabDrop(e.dataTransfer.getData(TAB_MIME), e.clientX, e.clientY);
      else onSessionDrop(e.dataTransfer.getData(SESSION_MIME), e.clientX, e.clientY);
    },
  };
  const hintBox = dropHint && (
    <div
      className="drop-hint"
      style={{ left: dropHint.rect.left, top: dropHint.rect.top, width: dropHint.rect.width, height: dropHint.rect.height }}
    />
  );

  if (!root) {
    if (hideWelcome) return <div className="workspace-empty" data-drop-stage {...dropHandlers}>{hintBox}</div>;
    return (
      <div className="workspace-empty" data-drop-stage {...dropHandlers}>
        {hintBox}
        <div className="empty-card">
          <div className="empty-logo">&gt;_</div>
          <h2>Nexterm</h2>
          <p className="empty-subtitle">{t("workspace.subtitle")}</p>
          <div className="empty-grid">
            <button type="button" className="empty-action-btn primary-tile" onClick={onOpenNewSessionModal}>
              <Plus size={18} />
              <div>
                <strong>{t("workspace.newSshTitle")}</strong>
                <span>{t("workspace.newSshDesc")}</span>
              </div>
            </button>
            <button type="button" className="empty-action-btn" onClick={() => onQuickShell("powershell")}>
              <Terminal size={18} />
              <div>
                <strong>{t("workspace.psTitle")}</strong>
                <span>{t("workspace.psDesc")}</span>
              </div>
            </button>
            <button type="button" className="empty-action-btn" onClick={() => onQuickShell("cmd")}>
              <SquareTerminal size={18} />
              <div>
                <strong>{t("workspace.cmdTitle")}</strong>
                <span>{t("workspace.cmdDesc")}</span>
              </div>
            </button>
            <button type="button" className="empty-action-btn" onClick={() => onQuickShell("wsl")}>
              <Cpu size={18} />
              <div>
                <strong>{t("workspace.wslTitle")}</strong>
                <span>{t("workspace.wslDesc")}</span>
              </div>
            </button>
          </div>
          <div className="empty-footer">
            <button type="button" className="btn-ghost" onClick={onOpenImportModal}>
              <Download size={14} /> {t("workspace.importFooter")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  let groups: GroupSlot[] = [];
  let dividers: DividerSlot[] = [];
  layoutTree(root, { x: 0, y: 0, w: 100, h: 100 }, groups, dividers);
  const zoomed = zoomedGroupId ? groups.find((g) => g.group.id === zoomedGroupId) : undefined;
  if (zoomed) {
    // Zoomed: that group fills the stage; the others stay mounted but hidden.
    groups = groups.map((g) =>
      g.group.id === zoomed.group.id ? { ...g, rect: { x: 0, y: 0, w: 100, h: 100 } } : { ...g, rect: { x: 0, y: 0, w: 0, h: 0 } }
    );
    dividers = [];
  }
  const hiddenGroup = (id: string) => Boolean(zoomed) && id !== zoomed!.group.id;
  const multiGroup = groups.length > 1;
  const tabbarH = focusMode ? 0 : TABBAR_H;

  // One flat, keyed list of every terminal: switching tabs, splitting, closing a
  // neighbour or dragging a tab to another group only changes styles, so a
  // terminal is never unmounted (which would drop its connection).
  const terminals: { leaf: TerminalLeafNode; slot: GroupSlot }[] = [];
  for (const slot of groups) {
    for (const leaf of slot.group.tabs) terminals.push({ leaf, slot });
  }
  terminals.sort((a, b) => (a.leaf.paneId < b.leaf.paneId ? -1 : 1));

  const startDrag = (d: DividerSlot) => (e: React.MouseEvent) => {
    e.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const box = stage.getBoundingClientRect();
    const px = {
      left: box.left + (box.width * d.parent.x) / 100,
      top: box.top + (box.height * d.parent.y) / 100,
      width: (box.width * d.parent.w) / 100,
      height: (box.height * d.parent.h) / 100,
    };
    const onMove = (ev: MouseEvent) => {
      const ratio = d.horizontal
        ? (ev.clientX - px.left) / Math.max(1, px.width)
        : (ev.clientY - px.top) / Math.max(1, px.height);
      onResizeSplit(d.splitId, ratio);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = d.horizontal ? "col-resize" : "row-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div ref={stageRef} className="workspace-tabs-stage group-stage" data-drop-stage {...dropHandlers}>
      {!focusMode &&
        groups.map(({ group, rect }) => (
          <div
            key={group.id}
            className={`group-tabbar-slot ${zoomed?.group.id === group.id ? "group-zoomed" : ""}`}
            style={{ ...boxStyle(rect, 0, TABBAR_H), display: hiddenGroup(group.id) ? "none" : "flex" }}
          >
            <GroupTabBar
              group={group}
              isActiveGroup={multiGroup && group.id === activeGroupId}
              syncChannels={extras.syncChannels}
              logPaths={extras.logPaths}
              tabMarks={extras.tabMarks}
              agentStates={extras.agentStates}
              hostnames={settings.tabHostname !== false ? extras.hostnames : undefined}
              runningCommands={settings.tabCommand !== false ? extras.runningCommands : undefined}
              commandWatches={extras.commandWatches}
              onToggleCommandWatch={groupActions.onToggleCommandWatch}
              onActivateGroup={() => groupActions.onActivateGroup(group.id)}
              onSelectTab={groupActions.onSelectTab}
              onCloseTab={groupActions.onCloseTab}
              onRenameTab={groupActions.onRenameTab}
              onPaneSettings={extras.onPaneSettings}
              onDuplicateTab={groupActions.onDuplicateTab}
              reuseSshConnection={settings.reuseSshConnection}
              onReconnectTab={groupActions.onReconnectTab}
              onInjectShellIntegration={groupActions.onInjectShellIntegration}
              onCloseOtherTabs={groupActions.onCloseOtherTabs}
              onCloseTabsToRight={groupActions.onCloseTabsToRight}
              onSplitGroup={(dir) => groupActions.onSplitGroup(group.id, dir)}
              onMoveToNewGroup={groupActions.onMoveToNewGroup}
              onDropTab={(paneId, index) => groupActions.onDropTab(paneId, group.id, index)}
              onSetTabColor={groupActions.onSetTabColor}
              onToggleLock={groupActions.onToggleLock}
              onMoveToNewWindow={groupActions.onMoveToNewWindow}
              moveToWindowTargets={groupActions.moveToWindowTargets}
              onMoveToWindow={groupActions.onMoveToWindow}
              onDragOutside={groupActions.onDragOutside}
              keymap={extras.keymap}
              tabMouse={{ doubleClick: settings.tabDoubleClick ?? "close", middleClick: settings.tabMiddleClick ?? "rename" }}
              hoverSwitch={settings.tabHoverSwitch ?? true}
              onNewTab={() => groupActions.onNewTab(group.id)}
              newTabMenu={() => groupActions.newTabMenu(group.id)}
              sessionMenu={() => groupActions.sessionMenu(group.id)}
            />
          </div>
        ))}

      {terminals.map(({ leaf, slot }) => {
        const visible = leaf.paneId === slot.group.activeTabId && !hiddenGroup(slot.group.id);
        return (
          <div
            key={leaf.paneId}
            className="split-slot"
            style={{ ...boxStyle(slot.rect, tabbarH), display: visible ? "flex" : "none" }}
          >
            {isDesktopProtocol(leaf.session.protocol) ? (
              <DesktopPane
                leaf={leaf}
                visible={visible}
                isActive={visible && slot.group.id === activeGroupId}
                extras={extras}
                onActivate={onActivatePane}
                onReconnectPane={onReconnectPane}
              />
            ) : (
            <TerminalPane
              leaf={leaf}
              visible={visible}
              isActive={visible && slot.group.id === activeGroupId}
              showSplitChrome={false}
              theme={theme}
              settings={settings}
              extras={extras}
              syncBadge={syncBadges[leaf.paneId] ?? null}
              onActivate={onActivatePane}
              onUserInput={onUserInput}
              onDimensionsChange={onDimensionsChange}
              onSplit={onSplitPane}
              onClosePane={onClosePane}
              onReconnectPane={onReconnectPane}
            />
            )}
          </div>
        );
      })}

      {/* Outline of each group panel, drawn over its tab bar and terminal; rings the active one. */}
      {groups.map(({ group, rect }) =>
        hiddenGroup(group.id) ? null : (
          <div
            key={`frame-${group.id}`}
            className={`group-frame ${multiGroup && group.id === activeGroupId ? "group-frame-active" : ""} ${
              zoomed?.group.id === group.id ? "group-frame-zoomed" : ""
            }`}
            style={boxStyle(rect)}
          />
        )
      )}

      {dividers.map((d) => (
        <div
          key={d.splitId}
          className={`split-divider ${d.horizontal ? "divider-vertical" : "divider-horizontal"}`}
          style={dividerStyle(d)}
          onMouseDown={startDrag(d)}
        />
      ))}
      {hintBox}
    </div>
  );
};
