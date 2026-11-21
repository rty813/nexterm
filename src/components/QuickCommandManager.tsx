import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Copy, Download, FolderPlus, Minus, PencilLine, Plus, Trash2, X } from "lucide-react";
import type { QuickBarSettings, QuickCommand } from "../types/domain";
import { ACTIONS, comboFromEvent } from "../utils/actions";
import {
  DEFAULT_QUICK_ICON,
  QUICK_ICON_COLORS,
  QUICK_ICON_SHAPES,
  commandsOf,
  fromEditor,
  moveInGroup,
  parseQuickIcon,
  quickGroups,
  toEditor,
} from "../utils/quickCommands";
import { QuickIcon } from "./QuickIcon";
import { useCloseGuard } from "./useCloseGuard";

/** Open the dialog on a command, or with a new command in a group. */
export interface QuickManagerTarget {
  id?: string;
  create?: boolean;
  group?: string;
}

interface QuickCommandManagerProps {
  commands: QuickCommand[];
  bar: QuickBarSettings;
  /** App shortcuts (actionId -> combo): a quick command cannot take one of them. */
  keymap: Record<string, string>;
  target?: QuickManagerTarget | null;
  onSave: (commands: QuickCommand[], bar: QuickBarSettings) => void;
  onClose: () => void;
  /** Read the local WindTerm quickbar.config; null when there is none. */
  onImportWindTerm: () => Promise<QuickCommand[] | null>;
}

function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `qc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Commands as edited here: lines joined with \n, the final Enter as a checkbox. */
const forEditing = (c: QuickCommand): QuickCommand => {
  const { text, enter } = toEditor(c);
  return { ...c, command: text, appendNewline: enter };
};

/**
 * Quick commands, WindTerm style: pick a group, the commands of that group on the left,
 * the selected command on the right; changes apply on OK.
 */
export const QuickCommandManager: React.FC<QuickCommandManagerProps> = ({
  commands,
  bar,
  keymap,
  target,
  onSave,
  onClose,
  onImportWindTerm,
}) => {
  const { t } = useTranslation();
  const fallback = t("quickbar.defaultGroup");

  const [draft, setDraft] = useState<QuickCommand[]>(() => commands.map(forEditing));
  const [opts, setOpts] = useState<Required<QuickBarSettings>>(() => ({
    groups: quickGroups(commands, bar, fallback),
    multiGroups: bar.multiGroups ?? true,
    groupTitles: bar.groupTitles ?? true,
    sortAlpha: bar.sortAlpha ?? false,
  }));
  const [initialJson] = useState(() => JSON.stringify({ draft, opts }));
  const { requestClose, prompt } = useCloseGuard(JSON.stringify({ draft, opts }) !== initialJson, onClose);

  const groups = useMemo(() => {
    const list = quickGroups(draft, opts, fallback);
    return list.length ? list : [fallback];
  }, [draft, opts, fallback]);

  const startGroup =
    (target?.id && (draft.find((c) => c.id === target.id)?.group || fallback)) || target?.group || groups[0];
  const [group, setGroup] = useState<string>(startGroup);
  const [selectedId, setSelectedId] = useState<string | null>(
    () => target?.id ?? commandsOf(draft, startGroup, fallback)[0]?.id ?? null
  );
  const [groupEdit, setGroupEdit] = useState<{ mode: "add" | "rename"; value: string } | null>(null);
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState(false);
  const [iconOpen, setIconOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const labelRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => setIconOpen(false), [selectedId]);

  const inGroup = commandsOf(draft, group, fallback);
  const selected = draft.find((c) => c.id === selectedId) ?? null;

  const patch = (id: string, p: Partial<QuickCommand>) => setDraft((list) => list.map((c) => (c.id === id ? { ...c, ...p } : c)));

  const addCommand = (inGroupName = group) => {
    const c: QuickCommand = {
      id: uid(),
      label: t("quickManager.newLabel"),
      group: inGroupName,
      command: "",
      appendNewline: true,
      icon: DEFAULT_QUICK_ICON,
      kind: "text",
    };
    setDraft((list) => [...list, c]);
    setSelectedId(c.id);
    requestAnimationFrame(() => labelRef.current?.select());
  };

  // Opened with "add": start on a new command.
  const created = useRef(false);
  useEffect(() => {
    if (target?.create && !created.current) {
      created.current = true;
      addCommand(startGroup);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const removeSelected = () => {
    if (!selected) return;
    const idx = inGroup.findIndex((c) => c.id === selected.id);
    const rest = inGroup.filter((c) => c.id !== selected.id);
    setDraft((list) => list.filter((c) => c.id !== selected.id));
    setSelectedId(rest[Math.min(idx, rest.length - 1)]?.id ?? null);
  };

  const duplicateSelected = () => {
    if (!selected) return;
    const copy = { ...selected, id: uid(), label: `${selected.label} (${t("sidebar.copySuffix")})`, shortcut: undefined };
    setDraft((list) => {
      const i = list.findIndex((c) => c.id === selected.id);
      return [...list.slice(0, i + 1), copy, ...list.slice(i + 1)];
    });
    setSelectedId(copy.id);
  };

  const pickGroup = (g: string) => {
    setGroup(g);
    setSelectedId(commandsOf(draft, g, fallback)[0]?.id ?? null);
    setConfirmDeleteGroup(false);
    setGroupEdit(null);
  };

  const commitGroupEdit = () => {
    if (!groupEdit) return;
    const name = groupEdit.value.trim();
    if (!name) return setGroupEdit(null);
    if (name !== group && groups.includes(name)) {
      setNotice({ text: t("quickManager.groupExists", { name }), error: true });
      return;
    }
    if (groupEdit.mode === "add") {
      // The placeholder group shown when there is none goes away once a real one exists.
      const kept = groups.filter((g) => g !== fallback || opts.groups.includes(g) || commandsOf(draft, g, fallback).length > 0);
      setOpts((o) => ({ ...o, groups: [...kept, name] }));
      setGroup(name);
      setSelectedId(null);
    } else {
      setOpts((o) => ({ ...o, groups: groups.map((g) => (g === group ? name : g)) }));
      setDraft((list) => list.map((c) => ((c.group || fallback) === group ? { ...c, group: name } : c)));
      setGroup(name);
    }
    setGroupEdit(null);
    setNotice(null);
  };

  const deleteGroup = () => {
    setDraft((list) => list.filter((c) => (c.group || fallback) !== group));
    const rest = groups.filter((g) => g !== group);
    setOpts((o) => ({ ...o, groups: rest }));
    setConfirmDeleteGroup(false);
    const next = rest[0] ?? fallback;
    setGroup(next);
    setSelectedId(commandsOf(draft, next, fallback)[0]?.id ?? null);
  };

  /** The app action a combo already runs (it would win over the quick command). */
  const actionUsing = (combo: string) => ACTIONS.find((a) => keymap[a.id] === combo);

  const setShortcut = (combo: string) => {
    if (!selected) return;
    if (!combo) {
      patch(selected.id, { shortcut: undefined });
      return;
    }
    // Alt+1..9 switch tabs (App.tsx); they are not in the keymap.
    if (/^Alt\+[1-9]$/.test(combo)) {
      setNotice({ text: t("quickManager.shortcutReserved", { combo }), error: true });
      return;
    }
    const taken = actionUsing(combo);
    if (taken) {
      setNotice({ text: t("quickManager.shortcutTaken", { combo, action: t(`actions.${taken.id}`) }), error: true });
      return;
    }
    // One combo, one command: take it from whichever command had it.
    const other = draft.find((c) => c.id !== selected.id && c.shortcut === combo);
    setDraft((list) =>
      list.map((c) => (c.id === selected.id ? { ...c, shortcut: combo } : c.id === other?.id ? { ...c, shortcut: undefined } : c))
    );
    setNotice(other ? { text: t("quickManager.shortcutMoved", { combo, name: other.label }) } : null);
  };

  const importWindTerm = async () => {
    const list = await onImportWindTerm();
    if (!list) {
      setNotice({ text: t("quickManager.importNone"), error: true });
      return;
    }
    const incoming = list.map(forEditing);
    setDraft((cur) => {
      const next = [...cur];
      for (const c of incoming) {
        const i = next.findIndex((x) => x.id === c.id);
        if (i >= 0) next[i] = { ...c, shortcut: next[i].shortcut };
        else next.push(c);
      }
      return next;
    });
    setOpts((o) => ({ ...o, groups: quickGroups(incoming, o, fallback) }));
    setNotice({ text: t("quickManager.imported", { count: incoming.length }) });
  };

  const save = () => {
    const out = draft.map((c) => ({
      ...c,
      label: c.label.trim() || t("quickManager.newLabel"),
      ...(c.kind === "action" ? {} : fromEditor(c.command, c.appendNewline)),
    }));
    onSave(out, { ...opts, groups });
  };

  const icon = parseQuickIcon(selected?.icon);
  const isAction = selected?.kind === "action";
  const listRef = useRef<HTMLDivElement | null>(null);

  return (
    <div className="modal-backdrop" onMouseDown={requestClose}>
      <div className="modal-panel quick-manager" role="dialog" aria-label={t("quickManager.title")} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{t("quickManager.title")}</h3>
          <button type="button" className="icon-btn" onClick={requestClose} title={t("titlebar.close")}>
            <X size={16} />
          </button>
        </div>
        {prompt}

        <div className="qm-groupbar">
          <span className="qm-caption">{t("quickManager.group")}</span>
          {groupEdit ? (
            <form
              className="qm-group-edit"
              onSubmit={(e) => {
                e.preventDefault();
                commitGroupEdit();
              }}
            >
              <input
                autoFocus
                className="text-input input-sm"
                value={groupEdit.value}
                placeholder={t("quickManager.groupName")}
                onChange={(e) => setGroupEdit({ ...groupEdit, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setGroupEdit(null);
                  }
                }}
              />
              <button type="submit" className="btn-primary btn-xs">
                {groupEdit.mode === "add" ? t("quickManager.addGroup") : t("quickManager.renameGroup")}
              </button>
              <button type="button" className="btn-ghost btn-xs" onClick={() => setGroupEdit(null)}>
                {t("sessionModal.cancel")}
              </button>
            </form>
          ) : (
            <select className="text-input input-sm qm-group-select" value={group} onChange={(e) => pickGroup(e.target.value)}>
              {groups.map((g) => (
                <option key={g} value={g}>
                  {g} ({commandsOf(draft, g, fallback).length})
                </option>
              ))}
            </select>
          )}
          {!groupEdit && (
            <div className="qm-group-actions">
              <button type="button" className="btn-ghost btn-xs" onClick={() => setGroupEdit({ mode: "add", value: "" })}>
                <FolderPlus size={12} /> {t("quickManager.addGroup")}
              </button>
              <button type="button" className="btn-ghost btn-xs" onClick={() => setGroupEdit({ mode: "rename", value: group })}>
                <PencilLine size={12} /> {t("quickManager.renameGroup")}
              </button>
              <button
                type="button"
                className="btn-ghost btn-xs danger-hover"
                disabled={groups.length <= 1 && inGroup.length === 0}
                onClick={() => (inGroup.length ? setConfirmDeleteGroup(true) : deleteGroup())}
              >
                <Trash2 size={12} /> {t("quickManager.deleteGroup")}
              </button>
            </div>
          )}
        </div>
        {confirmDeleteGroup && (
          <div className="manager-banner banner-danger qm-banner">
            <span>{t("quickManager.deleteGroupConfirm", { name: group, count: inGroup.length })}</span>
            <button type="button" className="btn-danger btn-xs" onClick={deleteGroup}>
              {t("quickManager.deleteGroup")}
            </button>
            <button type="button" className="btn-ghost btn-xs" onClick={() => setConfirmDeleteGroup(false)}>
              {t("sessionModal.cancel")}
            </button>
          </div>
        )}

        <div className="qm-body">
          <div className="qm-list-pane">
            <div
              className="qm-list"
              role="listbox"
              tabIndex={0}
              ref={listRef}
              onKeyDown={(e) => {
                const i = inGroup.findIndex((c) => c.id === selectedId);
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  if (e.altKey && selectedId) {
                    setDraft((list) => moveInGroup(list, selectedId, e.key === "ArrowUp" ? -1 : 1, fallback));
                    return;
                  }
                  const next = inGroup[Math.max(0, Math.min(inGroup.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
                  if (next) setSelectedId(next.id);
                } else if (e.key === "Delete") {
                  e.preventDefault();
                  removeSelected();
                }
              }}
            >
              {inGroup.length === 0 && <div className="qm-empty">{t("quickManager.emptyGroup")}</div>}
              {inGroup.map((c) => (
                <div
                  key={c.id}
                  role="option"
                  aria-selected={c.id === selectedId}
                  className={`qm-item ${c.id === selectedId ? "selected" : ""}`}
                  onMouseDown={() => setSelectedId(c.id)}
                >
                  <QuickIcon icon={c.icon} size={13} />
                  <span className="qm-item-label">{c.label || t("quickManager.newLabel")}</span>
                  {c.shortcut && <kbd className="qm-kbd">{c.shortcut}</kbd>}
                </div>
              ))}
            </div>
            <div className="qm-list-tools">
              <button type="button" className="icon-btn-xs" title={t("quickManager.add")} onClick={() => addCommand()}>
                <Plus size={13} />
              </button>
              <button type="button" className="icon-btn-xs" title={t("quickManager.remove")} disabled={!selected} onClick={removeSelected}>
                <Minus size={13} />
              </button>
              <button
                type="button"
                className="icon-btn-xs"
                title={t("quickManager.moveUp")}
                disabled={!selected || inGroup[0]?.id === selectedId}
                onClick={() => selectedId && setDraft((list) => moveInGroup(list, selectedId, -1, fallback))}
              >
                <ArrowUp size={13} />
              </button>
              <button
                type="button"
                className="icon-btn-xs"
                title={t("quickManager.moveDown")}
                disabled={!selected || inGroup[inGroup.length - 1]?.id === selectedId}
                onClick={() => selectedId && setDraft((list) => moveInGroup(list, selectedId, 1, fallback))}
              >
                <ArrowDown size={13} />
              </button>
              <span className="toolbar-spacer" />
              <button type="button" className="btn-ghost btn-xs" disabled={!selected} onClick={duplicateSelected}>
                <Copy size={12} /> {t("quickManager.duplicate")}
              </button>
            </div>
          </div>

          <div className="qm-form">
            {!selected ? (
              <div className="qm-placeholder">
                <p>{inGroup.length ? t("quickManager.pickOne") : t("quickManager.emptyGroup")}</p>
                <button type="button" className="btn-secondary btn-sm" onClick={() => addCommand()}>
                  <Plus size={13} /> {t("quickManager.add")}
                </button>
              </div>
            ) : (
              <>
                <label className="qm-row">
                  <span>{t("quickManager.label")}</span>
                  <div className="qm-label-input">
                    <input
                      ref={labelRef}
                      className="text-input"
                      value={selected.label}
                      onChange={(e) => patch(selected.id, { label: e.target.value })}
                    />
                    <button
                      type="button"
                      className={`qm-icon-btn ${iconOpen ? "open" : ""}`}
                      title={t("quickManager.icon")}
                      onClick={(e) => {
                        e.preventDefault();
                        setIconOpen((v) => !v);
                      }}
                    >
                      <QuickIcon icon={selected.icon} size={15} />
                    </button>
                    {iconOpen && (
                      <div className="qm-icon-pop" onMouseDown={(e) => e.preventDefault()}>
                        <div className="qm-icon-colors">
                          {QUICK_ICON_COLORS.map((c) => (
                            <button
                              key={c}
                              type="button"
                              className={`qm-color ${icon.color === c ? "on" : ""}`}
                              style={{ background: c }}
                              title={c}
                              onClick={() => patch(selected.id, { icon: `${icon.shape}-${c}` })}
                            />
                          ))}
                        </div>
                        <div className="qm-icon-grid">
                          {QUICK_ICON_SHAPES.map((s) => (
                            <button
                              key={s}
                              type="button"
                              className={`qm-shape ${icon.shape === s ? "on" : ""}`}
                              title={s}
                              onClick={() => {
                                patch(selected.id, { icon: `${s}-${icon.color}` });
                                setIconOpen(false);
                              }}
                            >
                              <QuickIcon icon={`${s}-${icon.color}`} size={16} />
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </label>

                <div className="qm-row-pair">
                  <label className="qm-row">
                    <span>{t("quickManager.type")}</span>
                    <select
                      className="text-input"
                      value={selected.kind ?? "text"}
                      onChange={(e) => patch(selected.id, { kind: e.target.value as "text" | "action" })}
                    >
                      <option value="text">{t("quickManager.typeText")}</option>
                      <option value="action">{t("quickManager.typeAction")}</option>
                    </select>
                  </label>
                  <label className="qm-row">
                    <span>{t("quickManager.moveToGroup")}</span>
                    <select
                      className="text-input"
                      value={selected.group || fallback}
                      onChange={(e) => {
                        patch(selected.id, { group: e.target.value });
                        setGroup(e.target.value);
                      }}
                    >
                      {groups.map((g) => (
                        <option key={g} value={g}>
                          {g}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <label className="qm-row">
                  <span>{t("quickManager.shortcut")}</span>
                  <div className="qm-shortcut">
                    <input
                      readOnly
                      className={`text-input keymap-input ${recording ? "recording" : ""}`}
                      value={recording ? t("keys.pressKeys") : selected.shortcut || t("keys.none")}
                      onFocus={() => setRecording(true)}
                      onBlur={() => setRecording(false)}
                      onKeyDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const el = e.target as HTMLInputElement;
                        if (e.key === "Escape") return el.blur();
                        if (e.key === "Backspace" || e.key === "Delete") {
                          setShortcut("");
                          return el.blur();
                        }
                        const combo = comboFromEvent(e.nativeEvent);
                        // A bare letter or digit would type into the terminal: require a modifier or F-key.
                        if (!combo || (!/[+]/.test(combo) && !/^F\d+$/.test(combo))) return;
                        setShortcut(combo);
                        el.blur();
                      }}
                    />
                    {selected.shortcut && (
                      <button type="button" className="btn-ghost btn-xs" onClick={() => setShortcut("")}>
                        {t("quickManager.clearShortcut")}
                      </button>
                    )}
                  </div>
                </label>

                {isAction ? (
                  <label className="qm-row">
                    <span>{t("quickManager.action")}</span>
                    <select
                      className="text-input"
                      value={selected.action ?? ""}
                      onChange={(e) => patch(selected.id, { action: e.target.value || undefined })}
                    >
                      <option value="">{t("quickManager.pickAction")}</option>
                      {ACTIONS.map((a) => (
                        <option key={a.id} value={a.id}>
                          {t(`actions.${a.id}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label className="qm-row qm-text-row">
                    <span>{t("quickManager.text")}</span>
                    <textarea
                      className="text-input qm-text"
                      spellCheck={false}
                      value={selected.command}
                      placeholder={t("quickManager.textPlaceholder")}
                      onChange={(e) => patch(selected.id, { command: e.target.value })}
                    />
                  </label>
                )}
                {!isAction && (
                  <label className="checkbox-row qm-enter">
                    <input
                      type="checkbox"
                      checked={selected.appendNewline}
                      onChange={(e) => patch(selected.id, { appendNewline: e.target.checked })}
                    />
                    <span>{t("quickManager.enterAtEnd")}</span>
                  </label>
                )}
                {!isAction && (
                  <label className="checkbox-row qm-enter">
                    <input
                      type="checkbox"
                      checked={!!selected.escapes}
                      onChange={(e) => patch(selected.id, { escapes: e.target.checked || undefined })}
                    />
                    <span>{t("quickManager.escapes")}</span>
                  </label>
                )}
              </>
            )}
          </div>
        </div>

        {notice && <div className={`qm-notice ${notice.error ? "error" : ""}`}>{notice.text}</div>}

        <div className="qm-footer">
          <label className="checkbox-row">
            <input type="checkbox" checked={opts.multiGroups} onChange={(e) => setOpts({ ...opts, multiGroups: e.target.checked })} />
            <span>{t("quickManager.multiGroups")}</span>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={opts.groupTitles}
              disabled={!opts.multiGroups}
              onChange={(e) => setOpts({ ...opts, groupTitles: e.target.checked })}
            />
            <span>{t("quickManager.groupTitles")}</span>
          </label>
          <label className="checkbox-row">
            <input type="checkbox" checked={opts.sortAlpha} onChange={(e) => setOpts({ ...opts, sortAlpha: e.target.checked })} />
            <span>{t("quickManager.sortAlpha")}</span>
          </label>
          <span className="toolbar-spacer" />
          <button type="button" className="btn-ghost btn-sm" onClick={() => void importWindTerm()} title={t("quickbar.importTip")}>
            <Download size={13} /> {t("quickbar.importBtn")}
          </button>
          <button type="button" className="btn-ghost" onClick={requestClose}>
            {t("sessionModal.cancel")}
          </button>
          <button type="button" className="btn-primary" onClick={save}>
            {t("quickManager.ok")}
          </button>
        </div>
      </div>
    </div>
  );
};
