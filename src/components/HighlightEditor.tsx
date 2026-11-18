import React from "react";
import { useTranslation } from "react-i18next";
import { Highlighter, Plus, Trash2, X } from "lucide-react";
import type { HighlightRule } from "../types/domain";
import { buildMatcher, contrastText, HIGHLIGHT_PRESETS } from "../utils/textMatch";

export function newHighlightRule(patch: Partial<HighlightRule> = {}): HighlightRule {
  return {
    id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `hl-${Date.now()}`,
    pattern: "",
    regex: false,
    caseSensitive: false,
    wholeWord: false,
    mode: "background",
    color: HIGHLIGHT_PRESETS[0],
    textColor: null,
    enabled: true,
    ...patch,
  };
}

/** Keywords / patterns painted in one pane's output (the pane's own rules, not a setting). */
export const HighlightEditor: React.FC<{
  rules: HighlightRule[];
  /** Functional update, so quick successive edits never overwrite each other. */
  onChange: (update: (prev: HighlightRule[]) => HighlightRule[]) => void;
}> = ({ rules, onChange: update }) => {
  const { t } = useTranslation();
  const patch = (id: string, p: Partial<HighlightRule>) => update((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));

  return (
    <div className="hl-editor">
      <p className="adv-hint">{t("highlight.hint")}</p>
      {rules.length === 0 && <div className="hl-empty">{t("highlight.empty")}</div>}
      {rules.map((r) => {
        const { error } = buildMatcher(r.pattern, r);
        const preview =
          r.mode === "text"
            ? { color: r.color }
            : { background: r.color, color: r.textColor || contrastText(r.color) };
        return (
          <div key={r.id} className={`hl-rule ${r.enabled ? "" : "off"}`}>
            <div className="hl-rule-top">
              <input
                type="checkbox"
                checked={r.enabled}
                title={t("highlight.enabled")}
                onChange={(e) => patch(r.id, { enabled: e.target.checked })}
              />
              <input
                type="text"
                className={`text-input input-sm mono ${r.pattern && error && error !== "empty" ? "invalid" : ""}`}
                placeholder={t("highlight.patternPh")}
                title={error && error !== "empty" ? error : ""}
                value={r.pattern}
                onChange={(e) => patch(r.id, { pattern: e.target.value })}
              />
              <button type="button" className={`search-opt ${r.caseSensitive ? "on" : ""}`} title={t("search.caseSensitive")} onClick={() => patch(r.id, { caseSensitive: !r.caseSensitive })}>
                Aa
              </button>
              <button type="button" className={`search-opt ${r.wholeWord ? "on" : ""}`} title={t("search.wholeWord")} onClick={() => patch(r.id, { wholeWord: !r.wholeWord })}>
                <span className="whole-word">ab</span>
              </button>
              <button type="button" className={`search-opt ${r.regex ? "on" : ""}`} title={t("search.regex")} onClick={() => patch(r.id, { regex: !r.regex })}>
                .*
              </button>
              <button type="button" className="icon-btn-xs danger-hover" title={t("highlight.delete")} onClick={() => update((rs) => rs.filter((x) => x.id !== r.id))}>
                <Trash2 size={12} />
              </button>
            </div>
            <div className="hl-rule-bottom">
              <select
                className="text-input input-sm hl-mode"
                value={r.mode}
                onChange={(e) => patch(r.id, { mode: e.target.value as HighlightRule["mode"] })}
              >
                <option value="background">{t("highlight.modeBackground")}</option>
                <option value="text">{t("highlight.modeText")}</option>
              </select>
              <div className="swatch-row">
                {HIGHLIGHT_PRESETS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`swatch ${r.color.toLowerCase() === c ? "active" : ""}`}
                    style={{ background: c }}
                    title={t(`highlight.color.${c}`)}
                    onClick={() => patch(r.id, { color: c })}
                  />
                ))}
                <label className="swatch swatch-custom" title={t("highlight.custom")}>
                  <input type="color" value={r.color} onChange={(e) => patch(r.id, { color: e.target.value })} />
                </label>
              </div>
              <span className="hl-preview" style={preview}>
                {r.pattern || t("highlight.sample")}
              </span>
            </div>
          </div>
        );
      })}
      <button type="button" className="btn-secondary btn-sm hl-add" onClick={() => update((rs) => [...rs, newHighlightRule()])}>
        <Plus size={13} /> {t("highlight.add")}
      </button>
    </div>
  );
};

/** "Manage text highlights" of one pane; edits apply live. */
export const HighlightDialog: React.FC<{
  title: string;
  rules: HighlightRule[];
  onChange: (update: (prev: HighlightRule[]) => HighlightRule[]) => void;
  onClose: () => void;
}> = ({ title, rules, onChange, onClose }) => {
  const { t } = useTranslation();
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="modal-panel hl-dialog">
        <div className="modal-header">
          <h3>
            <Highlighter size={15} /> {t("highlight.title", { title })}
          </h3>
          <button type="button" className="icon-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <HighlightEditor rules={rules} onChange={onChange} />
        </div>
      </div>
    </div>
  );
};
