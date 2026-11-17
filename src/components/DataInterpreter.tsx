import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { backend } from "../services/backend";
import { INTERPRET_KEYS, interpretValue, type ByteSelection, type InterpretKey } from "../utils/dataInterpreter";

const ENDIAN_KEY = "nexterm.dataInterpreter.bigEndian";

const LABELS: Record<InterpretKey, string> = {
  int8: "8 Bit (±)",
  uint8: "8 Bit (+)",
  int16: "16 Bit (±)",
  uint16: "16 Bit (+)",
  int32: "32 Bit (±)",
  uint32: "32 Bit (+)",
  int64: "64 Bit (±)",
  uint64: "64 Bit (+)",
  float32: "Float",
  float64: "Double",
  binary: "Binary",
};

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");

/**
 * WinHex-style data interpreter for binary-mode panes: the bytes from the start of the
 * selection read as integers / floats. Click a value to copy it. Shown in every binary
 * pane; before any bytes are selected it says how to use it.
 */
export const DataInterpreter: React.FC<{ selection: ByteSelection | null; onClose: () => void }> = ({ selection, onClose }) => {
  const { t } = useTranslation();
  const [bigEndian, setBigEndian] = useState(() => localStorage.getItem(ENDIAN_KEY) === "1");
  const [copied, setCopied] = useState<InterpretKey | null>(null);
  const toggle = () => {
    localStorage.setItem(ENDIAN_KEY, bigEndian ? "0" : "1");
    setBigEndian(!bigEndian);
  };
  const bytes = selection?.bytes ?? new Uint8Array(0);

  return (
    <div className="data-interp" onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
      <div className="data-interp-header">
        <span>{t("interp.title")}</span>
        <button type="button" className="data-interp-endian" title={t("interp.endianTip")} onClick={toggle}>
          {bigEndian ? t("interp.big") : t("interp.little")}
        </button>
        <button type="button" className="icon-btn-xs" title={t("interp.close")} onClick={onClose}>
          <X size={12} />
        </button>
      </div>
      {selection ? (
        <>
          <div className="data-interp-info">
            {t("interp.offset", {
              hex: selection.offset.toString(16).toUpperCase().padStart(8, "0"),
              dec: selection.offset.toLocaleString("en-US"),
            })}
            {" · "}
            {t("interp.selected", { count: selection.selected })}
          </div>
          <div className="data-interp-bytes mono">{hex(bytes)}</div>
        </>
      ) : (
        <div className="data-interp-info data-interp-empty">{t("interp.empty")}</div>
      )}
      <div className="data-interp-grid mono">
        {INTERPRET_KEYS.map((key) => {
          const value = interpretValue(bytes, key, bigEndian);
          return (
            <React.Fragment key={key}>
              <span className="data-interp-label">{key === "binary" ? t("interp.binary") : LABELS[key]}:</span>
              <span
                className={`data-interp-value ${value === null ? "na" : ""} ${copied === key ? "copied" : ""}`}
                title={value === null ? t("interp.tooShort") : t("interp.copy")}
                onClick={() => {
                  if (value === null) return;
                  void backend.writeClipboard(value.replace(/,/g, ""));
                  setCopied(key);
                  window.setTimeout(() => setCopied((k) => (k === key ? null : k)), 800);
                }}
              >
                {value ?? "—"}
              </span>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};
