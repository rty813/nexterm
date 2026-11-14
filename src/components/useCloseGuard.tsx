import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";

/**
 * Closing a form dialog (backdrop click, X, Cancel, Escape) with unsaved edits asks
 * first, inside the dialog, instead of dropping the edits.
 *
 * `prompt` goes right under the dialog header; `requestClose` replaces `onClose`.
 */
export function useCloseGuard(dirty: boolean, onClose: () => void) {
  const { t } = useTranslation();
  const [asking, setAsking] = useState(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const requestClose = useCallback(() => {
    if (dirtyRef.current) setAsking(true);
    else onClose();
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      // A second Escape while asking keeps editing.
      setAsking((open) => {
        if (open) return false;
        if (dirtyRef.current) return true;
        onClose();
        return false;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const prompt = asking ? (
    <div className="close-guard" role="alertdialog">
      <TriangleAlert size={14} />
      <span>{t("closeGuard.message")}</span>
      <button type="button" className="btn-ghost btn-xs" onClick={() => setAsking(false)} autoFocus>
        {t("closeGuard.keepEditing")}
      </button>
      <button type="button" className="btn-danger btn-xs" onClick={onClose}>
        {t("closeGuard.discard")}
      </button>
    </div>
  ) : null;

  return { requestClose, prompt };
}
