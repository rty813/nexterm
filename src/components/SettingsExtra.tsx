import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import { ACTIONS, DEFAULT_TOOLBAR_HIDDEN, TOOLBAR_ITEMS, comboFromEvent, resolveKeymap } from "../utils/actions";
import type { AppSettings } from "../types/domain";

/** Settings > Shortcuts: click a field, press the new key combo. */
export const KeymapEditor: React.FC<{ draft: AppSettings; onChange: (next: AppSettings) => void }> = ({ draft, onChange }) => {
  const { t } = useTranslation();
  const [recording, setRecording] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const keymap = resolveKeymap(draft.keymap);

  const setKey = (id: string, combo: string) => {
    const overrides = { ...(draft.keymap ?? {}) };
    const def = ACTIONS.find((a) => a.id === id)?.defaultKey ?? "";
    if (combo === def) delete overrides[id];
    else overrides[id] = combo;
    // One combo, one action: clear it from whichever action had it.
    if (combo) {
      for (const other of ACTIONS) {
        if (other.id !== id && keymap[other.id] === combo) overrides[other.id] = "";
      }
    }
    onChange({ ...draft, keymap: overrides });
  };

  const q = filter.trim().toLowerCase();
  const groups = ["view", "terminal", "tab", "split", "window"] as const;

  return (
    <div className="keymap-editor">
      <div className="keymap-toolbar">
        <input
          type="text"
          className="text-input input-sm"
          placeholder={t("keys.search")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button type="button" className="btn-ghost btn-sm" onClick={() => onChange({ ...draft, keymap: {} })}>
          <RotateCcw size={12} /> {t("keys.resetAll")}
        </button>
      </div>
      <p className="adv-hint">{t("keys.hint")}</p>
      <div className="keymap-list">
        {groups.map((g) => {
          const rows = ACTIONS.filter((a) => a.group === g).filter(
            (a) => !q || t(`actions.${a.id}`).toLowerCase().includes(q) || keymap[a.id].toLowerCase().includes(q)
          );
          if (rows.length === 0) return null;
          return (
            <div key={g} className="keymap-group">
              <h4 className="section-heading">{t(`keys.group.${g}`)}</h4>
              {rows.map((a) => {
                const changed = draft.keymap && a.id in draft.keymap;
                return (
                  <div key={a.id} className="keymap-row">
                    <span className="keymap-label">{t(`actions.${a.id}`)}</span>
                    <input
                      readOnly
                      className={`text-input input-sm keymap-input ${recording === a.id ? "recording" : ""} ${changed ? "changed" : ""}`}
                      value={recording === a.id ? t("keys.pressKeys") : keymap[a.id] || t("keys.none")}
                      onFocus={() => setRecording(a.id)}
                      onBlur={() => setRecording(null)}
                      onKeyDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (e.key === "Escape") {
                          (e.target as HTMLInputElement).blur();
                          return;
                        }
                        if (e.key === "Backspace" || e.key === "Delete") {
                          setKey(a.id, "");
                          (e.target as HTMLInputElement).blur();
                          return;
                        }
                        const combo = comboFromEvent(e.nativeEvent);
                        if (!combo) return;
                        setKey(a.id, combo);
                        (e.target as HTMLInputElement).blur();
                      }}
                    />
                    <button
                      type="button"
                      className="icon-btn-xs"
                      title={t("keys.reset", { key: a.defaultKey || t("keys.none") })}
                      disabled={!changed}
                      onClick={() => setKey(a.id, a.defaultKey)}
                    >
                      <RotateCcw size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
};

/** Settings > Toolbar: tick the buttons to show. */
export const ToolbarEditor: React.FC<{ draft: AppSettings; onChange: (next: AppSettings) => void }> = ({ draft, onChange }) => {
  const { t } = useTranslation();
  const hidden = new Set(draft.toolbarHidden ?? []);
  return (
    <div className="toolbar-editor">
      <p className="adv-hint">{t("toolbarEdit.hint")}</p>
      <div className="toolbar-editor-grid">
        {TOOLBAR_ITEMS.map((item) => (
          <label key={item} className="checkbox-row">
            <input
              type="checkbox"
              checked={!hidden.has(item)}
              onChange={(e) => {
                const next = new Set(hidden);
                if (e.target.checked) next.delete(item);
                else next.add(item);
                onChange({ ...draft, toolbarHidden: Array.from(next) });
              }}
            />
            <span>{t(`toolbarEdit.item.${item}`)}</span>
          </label>
        ))}
      </div>
      <button type="button" className="btn-ghost btn-sm" onClick={() => onChange({ ...draft, toolbarHidden: [...DEFAULT_TOOLBAR_HIDDEN] })}>
        <RotateCcw size={12} /> {t("toolbarEdit.reset")}
      </button>
    </div>
  );
};
