import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, RotateCcw, Trash2 } from "lucide-react";
import type { AppSettings, TriggerRule } from "../types/domain";
import { builtinPattern, DEFAULT_TRIGGERS, patternError, triggersOf } from "../utils/triggers";

export function newTrigger(patch: Partial<TriggerRule> = {}): TriggerRule {
  return {
    id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `tr-${Date.now()}`,
    name: "",
    enabled: true,
    pattern: "",
    caseSensitive: false,
    tooltip: "",
    action: "none",
    actionText: "",
    activation: "ctrlClick",
    ...patch,
  };
}

/** Settings > Triggers: patterns in terminal output with a tooltip and a click action. */
export const TriggerEditor: React.FC<{
  draft: AppSettings;
  onChange: (update: (prev: AppSettings) => AppSettings) => void;
}> = ({ draft, onChange }) => {
  const { t } = useTranslation();
  const rules = triggersOf(draft);
  const [open, setOpen] = useState<string | null>(null);
  const update = (fn: (rules: TriggerRule[]) => TriggerRule[]) => onChange((prev) => ({ ...prev, triggers: fn(triggersOf(prev)) }));
  const patch = (id: string, p: Partial<TriggerRule>) => update((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const move = (id: string, by: number) =>
    update((rs) => {
      const i = rs.findIndex((r) => r.id === id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= rs.length) return rs;
      const next = [...rs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  return (
    <div className="hl-editor trigger-editor">
      <p className="adv-hint">{t("trigger.intro")}</p>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={draft.triggerUnderline !== false}
          onChange={(e) => onChange((prev) => ({ ...prev, triggerUnderline: e.target.checked }))}
        />
        <span>{t("trigger.underline")}</span>
      </label>
      {rules.map((r, i) => {
        const expanded = open === r.id;
        const name = r.builtin ? t(`trigger.builtin.${r.builtin}.name`) : r.name || t("trigger.unnamed");
        const error = r.builtin ? null : patternError(r.pattern, r.caseSensitive);
        return (
          <div key={r.id} className={`hl-rule ${r.enabled ? "" : "off"}`}>
            <div className="hl-rule-top">
              <input type="checkbox" checked={r.enabled} title={t("trigger.enabled")} onChange={(e) => patch(r.id, { enabled: e.target.checked })} />
              <button type="button" className="icon-btn-xs" onClick={() => setOpen(expanded ? null : r.id)} title={t("trigger.edit")}>
                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
              <span className="trigger-name" onClick={() => setOpen(expanded ? null : r.id)}>
                {name}
                {r.builtin && <span className="trigger-badge">{t("trigger.builtinBadge")}</span>}
              </span>
              <span className="trigger-summary mono" title={r.builtin ? builtinPattern(r.builtin) : r.pattern}>
                {r.builtin ? t(`trigger.builtin.${r.builtin}.desc`) : r.pattern}
              </span>
              <button type="button" className="icon-btn-xs" disabled={i === 0} title={t("trigger.moveUp")} onClick={() => move(r.id, -1)}>
                <ArrowUp size={12} />
              </button>
              <button type="button" className="icon-btn-xs" disabled={i === rules.length - 1} title={t("trigger.moveDown")} onClick={() => move(r.id, 1)}>
                <ArrowDown size={12} />
              </button>
              {!r.builtin && (
                <button type="button" className="icon-btn-xs danger-hover" title={t("trigger.delete")} onClick={() => update((rs) => rs.filter((x) => x.id !== r.id))}>
                  <Trash2 size={12} />
                </button>
              )}
            </div>
            {expanded && (
              <div className="trigger-body">
                {r.builtin ? (
                  <>
                    <p className="adv-hint">{t(`trigger.builtin.${r.builtin}.about`)}</p>
                    <label className="field">
                      <span>{t("trigger.pattern")}</span>
                      <input type="text" className="text-input input-sm mono" readOnly value={builtinPattern(r.builtin)} />
                    </label>
                  </>
                ) : (
                  <>
                    <label className="field">
                      <span>{t("trigger.name")}</span>
                      <input type="text" className="text-input input-sm" value={r.name} onChange={(e) => patch(r.id, { name: e.target.value })} />
                    </label>
                    <label className="field">
                      <span>{t("trigger.pattern")}</span>
                      <div className="trigger-row">
                        <input
                          type="text"
                          className={`text-input input-sm mono ${r.pattern && error ? "invalid" : ""}`}
                          placeholder={t("trigger.patternPh")}
                          title={error && error !== "empty" ? error : ""}
                          value={r.pattern}
                          onChange={(e) => patch(r.id, { pattern: e.target.value })}
                        />
                        <button
                          type="button"
                          className={`search-opt ${r.caseSensitive ? "on" : ""}`}
                          title={t("search.caseSensitive")}
                          onClick={() => patch(r.id, { caseSensitive: !r.caseSensitive })}
                        >
                          Aa
                        </button>
                      </div>
                    </label>
                    <label className="field">
                      <span>{t("trigger.tooltip")}</span>
                      <textarea
                        className="text-input input-sm mono trigger-script"
                        rows={3}
                        placeholder={t("trigger.tooltipPh")}
                        value={r.tooltip ?? ""}
                        onChange={(e) => patch(r.id, { tooltip: e.target.value })}
                      />
                    </label>
                    <div className="form-grid-2">
                      <label className="field">
                        <span>{t("trigger.action")}</span>
                        <select className="text-input input-sm" value={r.action ?? "none"} onChange={(e) => patch(r.id, { action: e.target.value as TriggerRule["action"] })}>
                          <option value="none">{t("trigger.actions.none")}</option>
                          <option value="sendText">{t("trigger.actions.sendText")}</option>
                          <option value="openLink">{t("trigger.actions.openLink")}</option>
                        </select>
                      </label>
                      {(r.action ?? "none") !== "none" && (
                        <label className="field">
                          <span>{t(r.action === "openLink" ? "trigger.linkText" : "trigger.sendText")}</span>
                          <input
                            type="text"
                            className="text-input input-sm mono"
                            placeholder={t(r.action === "openLink" ? "trigger.linkTextPh" : "trigger.sendTextPh")}
                            value={r.actionText ?? ""}
                            onChange={(e) => patch(r.id, { actionText: e.target.value })}
                          />
                        </label>
                      )}
                    </div>
                  </>
                )}
                {(r.builtin === "hyperlink" || r.builtin === "unarchiver" || (!r.builtin && (r.action ?? "none") !== "none")) && (
                  <label className="field">
                    <span>{t("trigger.activation")}</span>
                    <select
                      className="text-input input-sm"
                      value={r.activation ?? "ctrlClick"}
                      onChange={(e) => patch(r.id, { activation: e.target.value as TriggerRule["activation"] })}
                    >
                      <option value="ctrlClick">{t("trigger.how.ctrlClick")}</option>
                      <option value="click">{t("trigger.how.click")}</option>
                    </select>
                  </label>
                )}
              </div>
            )}
          </div>
        );
      })}
      <div className="trigger-buttons">
        <button
          type="button"
          className="btn-secondary btn-sm"
          onClick={() => {
            const rule = newTrigger();
            update((rs) => [...rs, rule]);
            setOpen(rule.id);
          }}
        >
          <Plus size={13} /> {t("trigger.add")}
        </button>
        <button type="button" className="btn-secondary btn-sm" onClick={() => onChange((prev) => ({ ...prev, triggers: DEFAULT_TRIGGERS }))}>
          <RotateCcw size={13} /> {t("trigger.reset")}
        </button>
      </div>
    </div>
  );
};
