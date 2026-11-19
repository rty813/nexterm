import React, { useEffect, useRef, useState } from "react";
import { commitNumberDraft, parseNumberDraft } from "../utils/numberDraft";

interface Props {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * A number field that can be cleared while editing. Valid in-range values apply as you type;
 * anything else is kept as text and settled (clamped, or reset to the current value) on blur.
 */
export const NumberInput: React.FC<Props> = ({ value, onChange, min, max, step, integer, disabled, className = "text-input" }) => {
  const [text, setText] = useState(String(value));
  const editing = useRef(false);
  const bounds = { min, max, integer };

  useEffect(() => {
    if (!editing.current) setText(String(value));
  }, [value]);

  return (
    <input
      type="number"
      className={className}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      value={text}
      onFocus={() => {
        editing.current = true;
      }}
      onChange={(e) => {
        setText(e.target.value);
        const n = parseNumberDraft(e.target.value, bounds);
        if (n !== null && n !== value) onChange(n);
      }}
      onBlur={() => {
        editing.current = false;
        const n = commitNumberDraft(text, value, bounds);
        setText(String(n));
        if (n !== value) onChange(n);
      }}
    />
  );
};
