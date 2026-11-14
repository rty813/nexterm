import React from "react";
import ReactDOM from "react-dom/client";
import "./i18n";
import { App } from "./App";
import { MenuHost } from "./components/ContextMenu";
import "./styles/app.css";
import { applyCachedThemeVars } from "./constants/themes";

applyCachedThemeVars();

// A file dropped outside a terminal must not make the webview open it in place of the app.
for (const type of ["dragover", "drop"] as const) {
  window.addEventListener(type, (e) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  });
}

const isMenuHost = window.location.hash === "#ctxmenu";
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
