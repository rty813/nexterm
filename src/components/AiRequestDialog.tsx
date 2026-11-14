import React, { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Bot, X } from "lucide-react";

/**
 * An agent asks for something through MCP (operate a pane, open a session). Nothing has
 * focus on purpose: the dialog can pop up while the user types in a terminal, and a stray
 * Enter must not answer it. Esc refuses.
 */
export const AiRequestDialog: React.FC<{
  /** Changes per request (resets the focus). */
  requestKey: string;
  title: string;
  message: string;
  /** What the agent says it wants to do. */
  reason?: string;
  note: string;
  allowLabel: string;
  /** More requests waiting after this one. */
  more: number;
  onAnswer: (accept: boolean) => void;
}> = ({ requestKey, title, message, reason, note, allowLabel, more, onAnswer }) => {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => panelRef.current?.focus(), [requestKey]);

  return (
    <div
      className="modal-backdrop"
      onKeyDown={(e) => {
        if (e.key === "Escape") onAnswer(false);
      }}
    >
      <div ref={panelRef} tabIndex={-1} className="modal-panel confirm-panel ai-request-panel">
        <div className="modal-header">
          <h3>
            <Bot size={16} /> {title}
          </h3>
          <button type="button" className="icon-btn" title={t("ai.requestDeny")} onClick={() => onAnswer(false)}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <p className="confirm-message">{message}</p>
          {reason && (
            <>
              <div className="ai-request-label">{t("ai.requestReason")}</div>
              <pre className="confirm-detail ai-request-reason">{reason}</pre>
            </>
          )}
          <p className="ai-request-note">{note}</p>
          {more > 0 && <p className="ai-request-note">{t("ai.requestMore", { count: more })}</p>}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-ghost" onClick={() => onAnswer(false)}>
            {t("ai.requestDeny")}
          </button>
          <button type="button" className="btn-primary" onClick={() => onAnswer(true)}>
            {allowLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
