import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown, Folder } from "lucide-react";
import { filterGroupOptions, groupOptions } from "../utils/sessionTree";

interface GroupInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Groups of the saved sessions; parent folders are offered too. */
  groups: string[];
  placeholder?: string;
}

const LIST_MAX = 220;

/**
 * The session form's group field: the existing groups drop down as soon as it is focused,
 * typing filters them, and a name that isn't listed makes a new group.
 */
export const GroupInput: React.FC<GroupInputProps> = ({ value, onChange, groups, placeholder }) => {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number } | null>(null);

  const options = useMemo(() => groupOptions(groups), [groups]);
  const shown = useMemo(() => filterGroupOptions(options, value), [options, value]);
  const visible = open && options.length > 0;

  // Fixed to the viewport (portal) so the scrolling dialog body doesn't clip the list.
  useLayoutEffect(() => {
    if (!visible) return;
    const place = () => {
      const rect = inputRef.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom;
      setPos(below < LIST_MAX + 8 && rect.top > below
        ? { left: rect.left, width: rect.width, bottom: window.innerHeight - rect.top + 4 }
        : { left: rect.left, width: rect.width, top: rect.bottom + 4 });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [visible]);

  useLayoutEffect(() => {
    if (active < 0) return;
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (group: string) => {
    onChange(group);
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (shown.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i < 0 ? (step > 0 ? 0 : shown.length - 1) : (i + step + shown.length) % shown.length));
    } else if (e.key === "Enter" && visible && active >= 0 && shown[active] !== undefined) {
      e.preventDefault(); // pick, don't submit the form
      pick(shown[active]);
    } else if (e.key === "Escape" && visible) {
      e.preventDefault(); // close the list, not the dialog
      setOpen(false);
      setActive(-1);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  const current = value.trim();

  return (
    <div className="combo">
      <input
        ref={inputRef}
        type="text"
        className="text-input"
        role="combobox"
        aria-expanded={visible}
        aria-autocomplete="list"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
      />
      {options.length > 0 && (
        <button
          type="button"
          className="combo-toggle"
          tabIndex={-1}
          title={t("sessionForm.pickGroup")}
          // Keep focus in the input; it opens / closes the list.
          onMouseDown={(e) => {
            e.preventDefault();
            if (document.activeElement !== inputRef.current) inputRef.current?.focus();
            else setOpen((o) => !o);
          }}
        >
          <ChevronDown size={14} />
        </button>
      )}
      {visible && pos &&
        createPortal(
          <ul
            ref={listRef}
            className="combo-list"
            role="listbox"
            style={{ position: "fixed", left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, right: "auto" }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {shown.length === 0 ? (
              <li className="combo-empty">{t("sessionForm.newGroup", { name: current })}</li>
            ) : (
              shown.map((group, i) => (
                <li
                  key={group}
                  role="option"
                  aria-selected={i === active}
                  className={`combo-item ${i === active ? "active" : ""} ${group === current ? "current" : ""}`}
                  title={group}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(group)}
                >
                  <Folder size={13} className="ac-icon" />
                  {group.split(">").map((part, j) => (
                    <React.Fragment key={j}>
                      {j > 0 && <span className="combo-sep">›</span>}
                      {part}
                    </React.Fragment>
                  ))}
                </li>
              ))
            )}
          </ul>,
          document.body
        )}
    </div>
  );
};
