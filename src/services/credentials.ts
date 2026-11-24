import { useEffect, useState } from "react";
import type { CredentialSummary } from "../types/domain";
import { backend } from "./backend";

/** The saved credentials (no secrets), kept current across windows, imports and syncs. */
export function useCredentials(): { list: CredentialSummary[]; loaded: boolean; error: string } {
  const [state, setState] = useState<{ list: CredentialSummary[]; loaded: boolean; error: string }>({ list: [], loaded: false, error: "" });
  useEffect(() => {
    let alive = true;
    const load = () => {
      backend.listCredentials().then(
        (list) => alive && setState({ list, loaded: true, error: "" }),
        (e) => alive && setState((s) => ({ ...s, error: String(e) }))
      );
    };
    load();
    const changed = backend.onCredentialsChanged(load);
    const applied = backend.onConfigApplied((categories) => {
      if (categories.includes("sessions")) load();
    });
    return () => {
      alive = false;
      void changed.then((f) => f());
      void applied.then((f) => f());
    };
  }, []);
  return state;
}
