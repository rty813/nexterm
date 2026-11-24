import React from "react";
import { useTranslation } from "react-i18next";
import { KeyRound } from "lucide-react";
import type { CredentialSummary, ProtocolType } from "../types/domain";
import { credentialsFor } from "../utils/credentials";

/** "Login" row of the session form: the session's own login or a saved credential. */
export const CredentialPicker: React.FC<{
  protocol: ProtocolType;
  list: CredentialSummary[];
  loaded: boolean;
  value: string;
  onChange: (id: string) => void;
  onManage: () => void;
}> = ({ protocol, list, loaded, value, onChange, onManage }) => {
  const { t } = useTranslation();
  const usable = credentialsFor(protocol, list);
  const known = list.some((c) => c.id === value);
  const shown = usable.some((c) => c.id === value) || (value && !known) ? value : "";
  return (
    <label className="field">
      <span>{t("credentials.login")}</span>
      <div className="input-with-btn">
        <select className="text-input" value={shown} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t("credentials.own")}</option>
          {usable.map((c) => (
            <option key={c.id} value={c.id}>
              {c.username ? `${c.name} (${c.username})` : c.name}
            </option>
          ))}
          {shown && !known && <option value={shown}>{loaded ? t("credentials.missing") : "…"}</option>}
        </select>
        <button type="button" className="btn-secondary" onClick={onManage} title={t("credentials.manage")}>
          <KeyRound size={14} />
        </button>
      </div>
    </label>
  );
};
