import React from "react";
import ReactDOM from "react-dom/client";
import "./i18n";
import { App } from "./App";
import { MenuHost } from "./components/ContextMenu";
import "./styles/app.css";
import "./styles/sftp.css";
import { applyCachedThemeVars } from "./constants/themes";

applyCachedThemeVars();

// A file dropped outside a terminal must not make the webview open it in place of the app.
for (const type of ["dragover", "drop"] as const) {
  window.addEventListener(type, (e) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  });
}

// Right-clicking where no component shows its own menu would bring up WebView2's browser menu
// (Back / Refresh / Save as / Print / More tools). Keep the native menu only in text fields,
// where it offers cut / copy / paste; xterm.js's hidden textarea is not one of them.
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number"]);
function keepsNativeMenu(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.classList.contains("xterm-helper-textarea")) return false;
  if (target instanceof HTMLTextAreaElement) return !target.disabled;
  if (target instanceof HTMLInputElement) return !target.disabled && TEXT_INPUT_TYPES.has(target.type);
  return target.isContentEditable;
}
window.addEventListener("contextmenu", (e) => {
  if (!keepsNativeMenu(e.target)) e.preventDefault();
});

const isMenuHost =window.location.hash === "#ctxmenu";
if (isMenuHost) document.documentElement.classList.add("ctxmenu-host");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isMenuHost ? (
      <MenuHost />
    ) : (
      <App />
    )}
  </React.StrictMode>
);
