import React, { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Clock, Hash, SquareTerminal, Zap } from "lucide-react";
import type { SuggestionState } from "../utils/terminalFeatures";

const ICONS = { history: Clock, quick: Zap, command: SquareTerminal, option: Hash } as const;

/** Suggestion list under the cursor (WindTerm auto completion). It never takes focus. */
export const AutoCompletePopup: React.FC<{ state: SuggestionState; onPick: (index: number) => void }> = ({ state, onPick }) => {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(".ac-item.selected");
    el?.scrollIntoView({ block: "nearest" });
  }, [state.selected]);

  return (
    <div
      className={`ac-popup ${state.above ? "above" : ""}`}
      style={{ left: state.left, top: state.top, maxHeight: state.visibleRows * 22 + 8 }}
      onMouseDown={(e) => {
        // Keep the focus (and the popup) in the terminal.
        e.preventDefault();
        e.stopPropagation();
      }}
      ref={listRef}
    >
      {state.items.map((item, i) => {
        const Icon = ICONS[item.kind];
        return (
          <div
            key={`${item.kind}:${item.label}`}
            className={`ac-item ${i === state.selected ? "selected" : ""}`}
            title={item.detail || t(`autocomplete.kind.${item.kind}`)}
            onClick={() => onPick(i)}
          >
            <Icon size={12} className={`ac-icon ac-${item.kind}`} />
            <span className="ac-label mono">{item.label}</span>
            {item.detail && <span className="ac-detail">{item.detail}</span>}
          </div>
        );
      })}
      <div className="ac-hint">{t("autocomplete.hint")}</div>
    </div>
  );
};
