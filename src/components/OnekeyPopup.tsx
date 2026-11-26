import React, { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, Plus } from "lucide-react";
import type { OnekeyPopupState, OnekeySentState } from "../utils/terminalFeatures";

/** OneKeys listed at a prompt (WindTerm OneKeys). Like the completion list, it never takes focus. */
export const OnekeyPopup: React.FC<{ state: OnekeyPopupState; onPick: (index: number) => void }> = ({ state, onPick }) => {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".ac-item.selected")?.scrollIntoView({ block: "nearest" });
  }, [state.selected]);

  return (
    <div
      ref={listRef}
      className={`ac-popup onekey-popup ${state.above ? "above" : ""}`}
      style={{ left: state.left, top: state.top, maxHeight: 8 * 24 + 60 }}
      role="listbox"
      aria-label="OneKey"
      onMouseDown={(e) => {
        // Keep the focus in the terminal.
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div className={`ac-head ${state.repeated ? "warn" : ""}`}>
        {t(
          state.repeated
            ? "onekey.repeated"
            : !state.items.length
            ? state.manual ? "onekey.noneTitle" : state.field === "username" ? "onekey.usernamePrompt" : "onekey.passwordPrompt"
            : state.manual ? "onekey.manualTitle" : "onekey.promptTitle"
        )}
      </div>
      {state.items.map((m, i) => (
        <div
          key={`${m.key.id}:${m.field}`}
          role="option"
          aria-selected={i === state.selected}
          className={`ac-item ${i === state.selected ? "selected" : ""}`}
          onClick={() => onPick(i)}
        >
          <Keyboard size={12} className="ac-icon" />
          <span className="ac-label">{m.key.name}</span>
          <span className="onekey-field">{t(m.field === "password" ? "onekey.fieldPassword" : "onekey.fieldUsername")}</span>
          {m.key.username && <span className="ac-detail mono">{m.key.username}</span>}
        </div>
      ))}
      <div
        role="option"
        aria-selected={state.selected === state.items.length}
        className={`ac-item onekey-add ${state.selected === state.items.length ? "selected" : ""}`}
        onClick={() => onPick(state.items.length)}
      >
        <Plus size={12} className="ac-icon" />
        <span className="ac-label">{t("onekey.addHere")}</span>
      </div>
      <div className="ac-hint">{t(state.items.length ? "onekey.hintKeys" : "onekey.hintAdd")}</div>
    </div>
  );
};

/** A moment's note that a OneKey was sent automatically (the only match of a prompt). */
export const OnekeySentNotice: React.FC<{ state: OnekeySentState }> = ({ state }) => {
  const { t } = useTranslation();
  return (
    <div className="onekey-sent" style={{ left: state.left, top: state.top, transform: state.above ? "translateY(-100%)" : undefined }} role="status">
      {t(state.field === "password" ? "onekey.sentPassword" : "onekey.sentUsername", { name: state.name })}
    </div>
  );
};
