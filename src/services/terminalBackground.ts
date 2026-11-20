import type { TerminalBackground } from "../types/domain";
import { backend } from "./backend";
import { backgroundCss, backgroundOf } from "../utils/themeCustom";

/**
 * Terminal background image: the stored file is read once per window into a blob URL and
 * painted once for the whole workspace by `.group-stage::before` (styles/app.css) from CSS variables on <html>. The
 * terminals draw a transparent background while settings.background.file is set (see TerminalPane).
 */
let loadedFile = "";
let loadSeq = 0;

const urlCache = new Map<string, Promise<string>>();

/** A blob URL for a stored background image (shared with the settings preview). */
export function backgroundImageUrl(file: string): Promise<string> {
  let url = urlCache.get(file);
  if (!url) {
    url = backend.readBackgroundImage(file).then((bytes) => URL.createObjectURL(new Blob([bytes])));
    url.catch(() => urlCache.delete(file));
    urlCache.set(file, url);
  }
  return url;
}

export function applyTerminalBackground(raw: TerminalBackground | undefined): void {
  const bg = backgroundOf(raw);
  const root = document.documentElement;
  const { size, repeat } = backgroundCss(bg.fit);
  root.style.setProperty("--term-bg-opacity", String(bg.opacity));
  root.style.setProperty("--term-bg-blur", `${bg.blur}px`);
  root.style.setProperty("--term-bg-size", size);
  root.style.setProperty("--term-bg-repeat", repeat);
  if (bg.file === loadedFile) return;
  loadedFile = bg.file;
  const seq = ++loadSeq;
  if (!bg.file) {
    clear();
    return;
  }
  void backgroundImageUrl(bg.file)
    .then((url) => {
      if (seq !== loadSeq) return;
      root.style.setProperty("--term-bg-image", `url("${url}")`);
      root.classList.add("has-term-bg");
    })
    .catch(() => {
      // File gone (another computer's setting, deleted folder): plain theme background.
      if (seq === loadSeq) clear();
    });
}

function clear() {
  const root = document.documentElement;
  root.classList.remove("has-term-bg");
  root.style.removeProperty("--term-bg-image");
}

