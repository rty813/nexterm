import React from "react";
import windterm from "../assets/import/windterm.svg";
import xshell from "../assets/import/xshell.svg";
import mobaxterm from "../assets/import/mobaxterm.svg";
import securecrt from "../assets/import/securecrt.svg";
import finalshell from "../assets/import/finalshell.svg";

export type ImportApp = "windterm" | "xshell" | "mobaxterm" | "securecrt" | "finalshell" | "openssh";

/** Each program's own icon (the same files NyaTerm's import dialog uses). */
const BRAND: Partial<Record<ImportApp, string>> = { windterm, xshell, mobaxterm, securecrt, finalshell };

/** OpenSSH has no app icon: a key on a gray tile. */
const OpenSshTile: React.FC<{ size: number }> = ({ size }) => (
  <svg className="import-app-icon is-tile" width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
    <defs>
      <linearGradient id="import-icon-openssh" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#7b8a99" />
        <stop offset="1" stopColor="#3d4955" />
      </linearGradient>
    </defs>
    <rect width="40" height="40" rx="10" fill="url(#import-icon-openssh)" />
    <g fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="15" cy="20" r="5" />
      <path d="M20 20h11M27 20v4M31 20v3" />
    </g>
  </svg>
);

export const ImportSourceIcon: React.FC<{ app: ImportApp; size?: number }> = ({ app, size = 36 }) => {
  const src = BRAND[app];
  if (!src) return <OpenSshTile size={size} />;
  return <img className="import-app-icon" src={src} width={size} height={size} alt="" draggable={false} />;
};
