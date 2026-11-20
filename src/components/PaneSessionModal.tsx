import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { TerminalLeafNode } from "../types/domain";
import { tabTitle } from "../utils/layout";
import { hasSavedPassword, type PaneSessionEdits } from "../utils/paneSession";
import { initialAdvanced, SessionAdvanced } from "./SessionAdvanced";
import { useCloseGuard } from "./useCloseGuard";

interface PaneSessionModalProps {
  leaf: TerminalLeafNode;
  isSaved: boolean;
  groups: string[];
  onClose: () => void;
  onApply: (edits: PaneSessionEdits, saveProfile: boolean, rememberPassword: boolean) => Promise<void>;
}

export function PaneSessionModal({ leaf, isSaved, groups, onClose, onApply }: PaneSessionModalProps) {
  const { t } = useTranslation();
  const [initial] = useState(() => ({
    label: tabTitle(leaf), group: leaf.session.group, term: leaf.session.term,
    advanced: initialAdvanced({ ...leaf.session, tabColor: leaf.color ?? null }),
  }));
  const [draft, setDraft] = useState(initial);
  const [rememberPassword, setRememberPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { requestClose, prompt } = useCloseGuard(draft !== initial || rememberPassword, () => { if (!saving) onClose(); });

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const saveProfile = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "save";
    const { charset, system, termOptions, tabColor } = draft.advanced;
    const edits = { label: draft.label.trim() || initial.label, group: draft.group.trim(), term: draft.term.trim() || "xterm-256color", charset, system, termOptions, tabColor };
    setSaving(true);
    setError("");
    try {
      await onApply(edits, saveProfile, rememberPassword);
      onClose();
    } catch (reason) {
      setError(String(reason));
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={saving ? undefined : requestClose}>
      <div className="modal-panel modal-lg session-form" role="dialog" aria-modal="true" aria-labelledby="pane-session-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h3 id="pane-session-title">{t("sessionForm.paneSettings")} · {tabTitle(leaf)}</h3>
          <button className="icon-btn" type="button" title={t("sessionModal.cancel")} onClick={requestClose} disabled={saving}><X size={16} /></button>
        </div>
        {prompt}
        <form className="modal-body" onSubmit={submit}>
          <div className="form-grid-2">
            <label className="field">
              <span>{t("sessionForm.label")}</span>
              <input className="text-input" value={draft.label} placeholder={initial.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} />
            </label>
            <label className="field">
              <span>{t("sessionForm.group")}</span>
              <input className="text-input" list="pane-session-groups" value={draft.group} onChange={(event) => setDraft({ ...draft, group: event.target.value })} />
              <datalist id="pane-session-groups">{groups.map((group) => <option key={group} value={group} />)}</datalist>
            </label>
          </div>
          <label className="field">
            <span>{t("sessionModal.termType")}</span>
            <input className="text-input" value={draft.term} onChange={(event) => setDraft({ ...draft, term: event.target.value })} />
          </label>
          <SessionAdvanced protocol={leaf.session.protocol} value={draft.advanced} onChange={(advanced) => setDraft({ ...draft, advanced })} terminalOnly />
          <p className="adv-hint">{t("sessionForm.reconnectHint")}</p>
          {!isSaved && leaf.session.authType === "password" && hasSavedPassword(leaf.session) && !leaf.session.credentialHandoff && (
            <label className="checkbox-row"><input type="checkbox" checked={rememberPassword} onChange={(event) => setRememberPassword(event.target.checked)} />{t("pane.rememberPwd")}</label>
          )}
          {error && <p role="alert">{t("storageLoc.failed", { error })}</p>}
          <div className="modal-footer">
            <button type="button" className="btn-ghost" onClick={requestClose} disabled={saving}>{t("sessionModal.cancel")}</button>
            <button type="submit" className="btn-secondary" value="apply" disabled={saving}>{t("sessionForm.applyToTab")}</button>
            <button type="submit" className="btn-primary" value="save" disabled={saving}>{t(isSaved ? "sessionForm.updateProfile" : "sessionForm.saveProfile")}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
