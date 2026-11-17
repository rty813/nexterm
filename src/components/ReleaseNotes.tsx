import React from "react";
import { parseNoteInline, parseReleaseNotes } from "../utils/updateCheck";

const Line: React.FC<{ line: string }> = ({ line }) => (
  <>
    {parseNoteInline(line).map((s, i) =>
      s.code ? <code key={i}>{s.text}</code> : s.bold ? <strong key={i}>{s.text}</strong> : <React.Fragment key={i}>{s.text}</React.Fragment>
    )}
  </>
);

const Lines: React.FC<{ lines: string[] }> = ({ lines }) => (
  <>
    {lines.map((l, i) => (
      <React.Fragment key={i}>
        {i > 0 && <br />}
        <Line line={l} />
      </React.Fragment>
    ))}
  </>
);

/** A release's notes in the update dialog, in the UI language where the notes are bilingual. */
export const ReleaseNotes: React.FC<{ notes: string; lang?: string }> = ({ notes, lang }) => {
  const blocks = parseReleaseNotes(notes, lang);
  if (!blocks.length) return null;
  // Consecutive list items share one <ul>.
  const out: React.ReactNode[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind === "li") {
      const items: React.ReactNode[] = [];
      for (; i < blocks.length && blocks[i].kind === "li"; i++) items.push(<li key={i}><Lines lines={blocks[i].lines} /></li>);
      i--;
      out.push(<ul key={`ul${i}`}>{items}</ul>);
    } else if (b.kind === "p") {
      out.push(<p key={i}><Lines lines={b.lines} /></p>);
    } else {
      const H = b.kind === "h2" ? "h4" : "h5";
      out.push(<H key={i}><Lines lines={b.lines} /></H>);
    }
  }
  return <div className="release-notes">{out}</div>;
};
