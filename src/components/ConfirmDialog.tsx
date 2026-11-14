import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ClipboardPaste, TriangleAlert, X } from "lucide-react";

export interface ConfirmRequest {
  title: string;
  message: string;
  /** Monospace text shown below the message (e.g. clipboard content). */
  detail?: string;
  okLabel?: string;
  cancelLabel?: string;
  /** A third answer, e.g. "Always allow". */
  extraLabel?: string;
  danger?: boolean;
  /** Checkbox under the message ("Don't ask again"). */
  checkboxLabel?: string;
}

export type ConfirmAnswer = { ok: boolean; extra: boolean; checked: boolean };

/** Generic modal question; Enter = OK, Esc = cancel. */
export const ConfirmDialog: React.FC<{ request: ConfirmRequest; onAnswer: (a: ConfirmAnswer) => void }> = ({ request, onAnswer }) => {
  const { t } = useTranslation();
  const [checked, setChecked] = useState(false);
  const okRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => okRef.current?.focus(), []);

  return (
    <div
      className="modal-backdrop"
      onKeyDown={(e) => {
        if (e.key === "Escape") onAnswer({ ok: false, extra: false, checked });
      }}
    >
      <div className={`modal-panel confirm-panel ${request.danger ? "danger" : ""}`}>
        <div className="modal-header">
          <h3>
            <TriangleAlert size={16} /> {request.title}
          </h3>
          <button type="button" className="icon-btn" onClick={() => onAnswer({ ok: false, extra: false, checked })}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <p className="confirm-message">{request.message}</p>
          {request.detail && <pre className="confirm-detail mono">{request.detail}</pre>}
          {request.checkboxLabel && (
            <label className="checkbox-row">
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
              <span>{request.checkboxLabel}</span>
            </label>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-ghost" onClick={() => onAnswer({ ok: false, extra: false, checked })}>
            {request.cancelLabel ?? t("confirm.cancel")}
          </button>
          {request.extraLabel && (
            <button type="button" className="btn-secondary" onClick={() => onAnswer({ ok: true, extra: true, checked })}>
              {request.extraLabel}
            </button>
          )}
          <button
            ref={okRef}
            type="button"
            className={request.danger ? "btn-danger" : "btn-primary"}
            onClick={() => onAnswer({ ok: true, extra: false, checked })}
          >
            {request.okLabel ?? t("confirm.ok")}
          </button>
        </div>
      </div>
    </div>
  );
};

/** Multi-line paste confirmation (WindTerm terminal.screen.pasteDialog): edit, paste, or paste as one line. */
export const PasteDialog: React.FC<{
  text: string;
  onPaste: (text: string) => void;
  onCancel: () => void;
  onDisable: () => void;
}> = ({ text, onPaste, onCancel, onDisable }) => {
  const { t } = useTranslation();
  const [value, setValue] = useState(text);
  const lines = value.replace(/(\r\n|\r|\n)$/, "").split(/\r\n|\r|\n/).length;
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => areaRef.current?.focus(), []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.stopPropagation()}>
      <div className="modal-panel paste-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>
            <ClipboardPaste size={16} /> {t("paste.title", { lines })}
          </h3>
          <button type="button" className="icon-btn" onClick={onCancel}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <p className="adv-hint">{t("paste.hint")}</p>
          <textarea
            ref={areaRef}
            className="text-input mono paste-area"
            value={value}
            spellCheck={false}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onCancel();
              if (e.key === "Enter" && e.ctrlKey) onPaste(value);
            }}
          />
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-ghost btn-sm mr-auto" onClick={onDisable} title={t("paste.disableTip")}>
            {t("paste.disable")}
          </button>
          <button type="button" className="btn-ghost" onClick={onCancel}>
            {t("confirm.cancel")}
          </button>
          <button type="button" className="btn-secondary" onClick={() => onPaste(value.replace(/\s*(\r\n|\r|\n)\s*/g, " ").trim())}>
            {t("paste.oneLine")}
          </button>
          <button type="button" className="btn-primary" onClick={() => onPaste(value)}>
            {t("paste.paste")} (Ctrl+Enter)
          </button>
        </div>
      </div>
    </div>
  );
};
