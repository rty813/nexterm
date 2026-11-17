import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { backend } from "../services/backend";
import type { SystemFont } from "../types/domain";
import { primaryFont, setPrimaryFont } from "../utils/fontStack";

interface FontFamilyFieldProps {
  value: string;
  onChange: (stack: string) => void;
}

/** Terminal font: pick an installed family, or edit the whole CSS stack by hand. */
export const FontFamilyField: React.FC<FontFamilyFieldProps> = ({ value, onChange }) => {
  const { t } = useTranslation();
  // null while the list is being read.
  const [fonts, setFonts] = useState<SystemFont[] | null>(null);
  const [monoOnly, setMonoOnly] = useState(true);

  useEffect(() => {
    let alive = true;
    void backend.listSystemFonts().then((list) => alive && setFonts(list));
    return () => {
      alive = false;
    };
  }, []);

  const primary = primaryFont(value);
  const installed = useMemo(
    () => fonts?.some((f) => f.name.toLowerCase() === primary.toLowerCase()) ?? false,
    [fonts, primary],
  );
  const shown = useMemo(() => {
    const list = (fonts ?? []).filter((f) => !monoOnly || f.monospace);
    // Keep the current choice selectable even when it's filtered out or not installed.
    if (primary && !list.some((f) => f.name.toLowerCase() === primary.toLowerCase())) {
      const current = fonts?.find((f) => f.name.toLowerCase() === primary.toLowerCase());
      list.unshift(current ?? { name: primary, monospace: false });
    }
    return list;
  }, [fonts, monoOnly, primary]);
  const selected = shown.find((f) => f.name.toLowerCase() === primary.toLowerCase())?.name ?? "";

  return (
    <div className="font-family-field">
      {fonts && fonts.length > 0 && (
        <div className="font-family-pick">
          <label className="field">
            <span>{t("settingsModal.fontFamily")}</span>
            <select
              className="text-input"
              value={selected}
              onChange={(e) => onChange(setPrimaryFont(value, e.target.value))}
            >
              {!primary && <option value="" />}
              {shown.map((f) => (
                <option key={f.name} value={f.name} style={{ fontFamily: `'${f.name}'` }}>
                  {f.name}
                  {f.name.toLowerCase() === primary.toLowerCase() && !installed
                    ? ` ${t("settingsModal.fontNotInstalled")}`
                    : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox-row">
            <input type="checkbox" checked={monoOnly} onChange={(e) => setMonoOnly(e.target.checked)} />
            <span>{t("settingsModal.fontMonoOnly")}</span>
          </label>
        </div>
      )}

      <label className="field">
        <span>
          {fonts && fonts.length > 0 ? t("settingsModal.fontStack") : t("settingsModal.fontFamily")}
          {fonts === null && <em className="font-family-loading"> {t("settingsModal.fontLoading")}</em>}
        </span>
        <input
          type="text"
          className="text-input"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>

      <div className="font-family-preview" style={{ fontFamily: value }}>
        AaBbCc 0O 1lI {"{}"} =&gt; != 中文字体 ┌─┐
      </div>
    </div>
  );
};
