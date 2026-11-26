import { useEffect, useState } from "react";
import { backend } from "../services/backend";

/** Whether Git for Windows is installed, so the quick-shell menus can offer Git Bash. */
export function useGitBashFound(): boolean {
  const [found, setFound] = useState(false);
  useEffect(() => {
    let live = true;
    void backend.findGitBash().then((path) => live && setFound(Boolean(path)));
    return () => {
      live = false;
    };
  }, []);
  return found;
}
