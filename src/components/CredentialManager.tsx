import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff, FolderOpen, Keyboard, KeyRound, Plus, Trash2, X } from "lucide-react";
import { backend } from "../services/backend";
import { useCredentials } from "../services/credentials";
import type { CredentialInput, CredentialSummary, Expect, OnekeyExpect } from "../types/domain";
import { compileExpect, DEFAULT_EXPECT } from "../utils/onekey";
import { useCloseGuard } from "./useCloseGuard";

interface Draft {
  id?: string;
  name: string;
  username: string;
  authType: "password" | "privatekey";
  /** undefined: untouched, the saved one is kept. */
  password?: string;
  privateKeyPath: string;
  passphrase?: string;
  login: boolean;
  onekey: boolean;
  expect: OnekeyExpect;
}

const EMPTY: Draft = { name: "", username: "", authType: "password", privateKeyPath: "", login: true, onekey: false, expect: DEFAULT_EXPECT };
const EMPTY_ONEKEY: Draft = { ...EMPTY, login: false, onekey: true };

const draftOf = (c: CredentialSummary): Draft => ({
  id: c.id,
  name: c.name,
  username: c.username,
  authType: c.authType === "privatekey" ? "privatekey" : "password",
  privateKeyPath: c.privateKeyPath ?? "",
  login: c.login !== false,
  onekey: Boolean(c.onekey),
  expect: c.expect ?? DEFAULT_EXPECT,
});

/** One Expect rule: the pattern and its regex / case / whole word switches (WindTerm OneKeys). */
const ExpectRow: React.FC<{ value: Expect; onChange: (next: Expect) => void }> = ({ value, onChange }) => {
  const { t } = useTranslation();
  const { error } = compileExpect(value);
  const set = (p: Partial<Expect>) => onChange({ ...value, ...p });
  return (
    <div className="qm-row">
      <span>{t("onekey.expect")}</span>
      <div className="onekey-expect">
        <input
          type="text"
          className={`text-input mono ${error ? "invalid" : ""}`}
          placeholder={t("onekey.expectPh")}
          title={error ?? ""}
          spellCheck={false}
          value={value.pattern}
          onChange={(e) => set({ pattern: e.target.value })}
        />
        <button type="button" className={`search-opt ${value.regex ? "on" : ""}`} title={t("search.regex")} onClick={() => set({ regex: !value.regex })}>
          .*
        </button>
        <button type="button" className={`search-opt ${value.caseSensitive ? "on" : ""}`} title={t("search.caseSensitive")} onClick={() => set({ caseSensitive: !value.caseSensitive })}>
          Aa
        </button>
        <button type="button" className={`search-opt ${value.wholeWord ? "on" : ""}`} title={t("search.wholeWord")} onClick={() => set({ wholeWord: !value.wholeWord })}>
          <span className="whole-word">ab</span>
        </button>
      </div>
    </div>
  );
};

/**
 * Saved logins that sessions refer to, and OneKeys offered at prompts in the terminal (one
 * credential can be both). Secrets are write-only here: the backend never sends them back.
 */
export const CredentialManager: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useTranslation();
  const { list, loaded, error: loadError } = useCredentials();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState("null");
  const [asking, setAsking] = useState<"delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  const dirty = JSON.stringify(draft) !== baseline;
  const { requestClose, prompt } = useCloseGuard(dirty, () => {
    if (!busy) onClose();
  });

  const show = (d: Draft | null) => {
    setDraft(d);
    setBaseline(JSON.stringify(d));
    setAsking(null);
    setReveal(false);
  };

  // Start on the first credential.
  const started = useRef(false);
  useEffect(() => {
    if (!loaded || started.current) return;
    started.current = true;
    if (list.length) show(draftOf(list[0]));
  }, [loaded, list]);

  const saved = draft?.id ? list.find((c) => c.id === draft.id) : undefined;
  const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name, "zh"));
  const groups = [
    { id: "login", title: t("onekey.groupLogin"), items: sorted.filter((c) => c.login !== false) },
    { id: "onekey", title: t("onekey.groupOnekey"), items: sorted.filter((c) => c.onekey) },
  ];
  const errorText = (e: unknown) => {
    const code = String(e);
    return t([`credentials.err.${code}`, `cfgSync.err.${code}`], { defaultValue: code });
  };
  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const badExpect = Boolean(draft?.onekey && (compileExpect(draft.expect.username).error || compileExpect(draft.expect.password).error));

  const pick = (next: Draft) => {
    if (dirty) {
      setNotice({ text: t("credentials.saveFirst"), error: true });
      return;
    }
    setNotice(null);
    show(next);
    if (!next.id) requestAnimationFrame(() => nameRef.current?.focus());
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft || busy || badExpect) return;
    // A OneKey types a user name / password: it is always a password credential.
    const key = draft.authType === "privatekey" && !draft.onekey;
    const input: CredentialInput = {
      id: draft.id,
      name: draft.name,
      username: draft.username,
      authType: key ? "privatekey" : "password",
      password: key ? undefined : draft.password,
      privateKeyPath: key ? draft.privateKeyPath : undefined,
      passphrase: key ? draft.passphrase : undefined,
      login: draft.login,
      onekey: draft.onekey,
      expect: draft.expect,
    };
    setBusy(true);
    try {
      const id = await backend.saveCredential(input);
      // The typed secrets are not kept in the page.
      show({
        ...draft,
        id,
        authType: input.authType === "privatekey" ? "privatekey" : "password",
        name: draft.name.trim(),
        username: draft.username.trim(),
        password: undefined,
        passphrase: undefined,
      });
      setNotice({ text: t("credentials.saved") });
    } catch (err) {
      setNotice({ text: errorText(err), error: true });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!draft?.id || busy) return;
    setBusy(true);
    try {
      await backend.deleteCredential(draft.id);
      const rest = sorted.filter((c) => c.id !== draft.id);
      show(rest.length ? draftOf(rest[0]) : null);
      setNotice({ text: t("credentials.deleted") });
    } catch (err) {
      setAsking(null);
      setNotice({ text: errorText(err), error: true });
    } finally {
      setBusy(false);
    }
  };

  const pickKey = async () => {
    const path = await backend.pickFile(t("sessionModal.selectKeyTitle"));
    if (path) patch({ privateKeyPath: path });
  };

  const secretHint = (has?: boolean) => (has ? t("credentials.keepSaved") : "");
  const kindLabel = (c: CredentialSummary) =>
    [c.login !== false && t(c.authType === "privatekey" ? "credentials.kindKey" : "credentials.kindPassword"), c.onekey && "OneKey"]
      .filter(Boolean)
      .join(" · ");

  const passwordInput = (placeholder: string) => (
    <div className="input-with-btn">
      <input
        type={reveal ? "text" : "password"}
        className="text-input"
        autoComplete="new-password"
        placeholder={placeholder}
        value={draft?.password ?? ""}
        // Emptied again: keep the saved one.
        onChange={(e) => patch({ password: e.target.value || undefined })}
      />
      <button type="button" className="btn-secondary" onClick={() => setReveal((r) => !r)} title={t(reveal ? "onekey.hide" : "onekey.show")}>
        {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  );

  return (
    <div className="modal-backdrop" onMouseDown={requestClose}>
      <div className="modal-panel quick-manager" role="dialog" aria-modal="true" aria-label={t("credentials.title")} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{t("credentials.title")}</h3>
          <button type="button" className="icon-btn" onClick={requestClose} title={t("titlebar.close")}>
            <X size={16} />
          </button>
        </div>
        {prompt}
        {asking === "delete" && (
          <div className="manager-banner banner-danger">
            <span>
              {saved?.usedBy
                ? t("credentials.confirmDeleteUsed", { name: saved.name, count: saved.usedBy })
                : t("credentials.confirmDelete", { name: saved?.name ?? "" })}
            </span>
            <button type="button" className="btn-danger btn-sm" onClick={() => void remove()} disabled={busy}>
              {t("credentials.delete")}
            </button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setAsking(null)}>
              {t("sessionModal.cancel")}
            </button>
          </div>
        )}

        <div className="qm-body">
          <div className="qm-list-pane">
            <div className="qm-list" role="listbox" aria-label={t("credentials.title")}>
              {groups.map((g) =>
                g.items.length ? (
                  <React.Fragment key={g.id}>
                    <div className="qm-group-title">{g.title}</div>
                    {g.items.map((c) => (
                      <div
                        key={`${g.id}:${c.id}`}
                        role="option"
                        aria-selected={c.id === draft?.id}
                        tabIndex={0}
                        className={`qm-item ${c.id === draft?.id ? "selected" : ""}`}
                        title={c.username || undefined}
                        onClick={() => c.id !== draft?.id && pick(draftOf(c))}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && c.id !== draft?.id) pick(draftOf(c));
                        }}
                      >
                        {g.id === "onekey" ? <Keyboard size={13} /> : <KeyRound size={13} />}
                        <span className="qm-item-label">{c.name}</span>
                        <span className="qm-kbd">{kindLabel(c)}</span>
                      </div>
                    ))}
                  </React.Fragment>
                ) : null
              )}
              {loaded && !list.length && <div className="qm-empty">{t("credentials.empty")}</div>}
              {loadError && <div className="qm-empty">{errorText(loadError)}</div>}
            </div>
            <div className="qm-list-tools">
              <button type="button" className="icon-btn-xs" title={t("credentials.add")} onClick={() => pick(EMPTY)}>
                <Plus size={14} />
              </button>
              <button type="button" className="icon-btn-xs" title={t("onekey.add")} onClick={() => pick(EMPTY_ONEKEY)}>
                <Keyboard size={14} />
              </button>
              <button type="button" className="icon-btn-xs" title={t("credentials.delete")} disabled={!saved || busy} onClick={() => setAsking("delete")}>
                <Trash2 size={14} />
              </button>
            </div>
          </div>

          {draft ? (
            <form id="credential-form" className="qm-form" autoComplete="off" onSubmit={(e) => void save(e)}>
              <label className="qm-row">
                <span>{t("credentials.name")}</span>
                <input ref={nameRef} type="text" className="text-input" value={draft.name} onChange={(e) => patch({ name: e.target.value })} required />
              </label>
              <div className="qm-row">
                <span>{t("onekey.usage")}</span>
                <div className="onekey-usage">
                  <label className="checkbox-row">
                    <input type="checkbox" checked={draft.login} onChange={(e) => patch({ login: e.target.checked })} />
                    <span>{t("onekey.usageLogin")}</span>
                  </label>
                  <label className="checkbox-row">
                    <input type="checkbox" checked={draft.onekey} onChange={(e) => patch({ onekey: e.target.checked })} />
                    <span>{t("onekey.usageOnekey")}</span>
                  </label>
                </div>
              </div>

              {draft.onekey ? (
                <>
                  <fieldset className="onekey-box">
                    <legend>{t("sessionModal.username")}</legend>
                    <ExpectRow value={draft.expect.username} onChange={(username) => patch({ expect: { ...draft.expect, username } })} />
                    <label className="qm-row">
                      <span>{t("onekey.send")}</span>
                      <input
                        type="text"
                        className="text-input"
                        placeholder={draft.login ? t("credentials.usernamePh") : ""}
                        value={draft.username}
                        onChange={(e) => patch({ username: e.target.value })}
                      />
                    </label>
                  </fieldset>
                  <fieldset className="onekey-box">
                    <legend>{t("credentials.kindPassword")}</legend>
                    <ExpectRow value={draft.expect.password} onChange={(password) => patch({ expect: { ...draft.expect, password } })} />
                    <div className="qm-row">
                      <span>{t("onekey.send")}</span>
                      {passwordInput(saved?.hasPassword ? t("credentials.keepSaved") : draft.login ? "" : t("onekey.passwordPh"))}
                    </div>
                  </fieldset>
                  <button type="button" className="btn-ghost btn-sm onekey-reset" onClick={() => patch({ expect: DEFAULT_EXPECT })}>
                    {t("onekey.resetRules")}
                  </button>
                  <p className="adv-hint">{t(draft.login ? "onekey.hintBoth" : "onekey.hint")}</p>
                </>
              ) : (
                <>
                  <div className="qm-row-pair">
                    <label className="qm-row">
                      <span>{t("sessionModal.username")}</span>
                      <input
                        type="text"
                        className="text-input"
                        placeholder={t("credentials.usernamePh")}
                        value={draft.username}
                        onChange={(e) => patch({ username: e.target.value })}
                      />
                    </label>
                    <label className="qm-row">
                      <span>{t("sessionModal.authType")}</span>
                      <select className="text-input" value={draft.authType} onChange={(e) => patch({ authType: e.target.value as Draft["authType"] })}>
                        <option value="password">{t("credentials.kindPassword")}</option>
                        <option value="privatekey">{t("credentials.kindKey")}</option>
                      </select>
                    </label>
                  </div>
                  {draft.authType === "password" ? (
                    <div className="qm-row">
                      <span>{t("credentials.kindPassword")}</span>
                      {passwordInput(secretHint(saved?.hasPassword))}
                    </div>
                  ) : (
                    <>
                      <label className="qm-row">
                        <span>{t("sessionModal.keyFile")}</span>
                        <div className="input-with-btn">
                          <input
                            type="text"
                            className="text-input"
                            placeholder="~/.ssh/id_ed25519"
                            value={draft.privateKeyPath}
                            onChange={(e) => patch({ privateKeyPath: e.target.value })}
                          />
                          <button type="button" className="btn-secondary" onClick={() => void pickKey()} title={t("sessionModal.selectKeyTitle")}>
                            <FolderOpen size={14} />
                          </button>
                        </div>
                      </label>
                      <label className="qm-row">
                        <span>{t("sessionModal.passphrase")}</span>
                        <input
                          type="password"
                          className="text-input"
                          autoComplete="new-password"
                          disabled={draft.passphrase === "" && saved?.hasPassphrase}
                          placeholder={draft.passphrase === "" ? t("credentials.passphraseCleared") : secretHint(saved?.hasPassphrase)}
                          value={draft.passphrase ?? ""}
                          onChange={(e) => patch({ passphrase: e.target.value || undefined })}
                        />
                      </label>
                      {saved?.hasPassphrase && (
                        <label className="checkbox-row">
                          <input
                            type="checkbox"
                            checked={draft.passphrase === ""}
                            onChange={(e) => patch({ passphrase: e.target.checked ? "" : undefined })}
                          />
                          <span>{t("credentials.clearPassphrase")}</span>
                        </label>
                      )}
                    </>
                  )}
                </>
              )}
              <p className="adv-hint">{t(draft.authType === "privatekey" && !draft.onekey ? "credentials.keyHint" : "credentials.storageHint")}</p>
              {saved && <p className="adv-hint">{t("credentials.usedBy", { count: saved.usedBy })}</p>}
            </form>
          ) : (
            <div className="qm-form">
              <div className="qm-placeholder">
                <KeyRound size={26} />
                <span>{t("credentials.placeholder")}</span>
                <div className="onekey-usage">
                  <button type="button" className="btn-primary btn-sm" onClick={() => pick(EMPTY)}>
                    <Plus size={13} /> {t("credentials.add")}
                  </button>
                  <button type="button" className="btn-secondary btn-sm" onClick={() => pick(EMPTY_ONEKEY)}>
                    <Keyboard size={13} /> {t("onekey.add")}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {notice && <div className={`qm-notice ${notice.error ? "error" : ""}`} role="status">{notice.text}</div>}

        <div className="qm-footer">
          <span className="toolbar-spacer" />
          {dirty && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setNotice(null);
                show(saved ? draftOf(saved) : sorted.length ? draftOf(sorted[0]) : null);
              }}
            >
              {t("credentials.revert")}
            </button>
          )}
          <button type="button" className="btn-ghost" onClick={requestClose}>
            {t("titlebar.close")}
          </button>
          <button type="submit" form="credential-form" className="btn-primary" disabled={!draft || !dirty || busy || badExpect}>
            {t("credentials.save")}
          </button>
        </div>
      </div>
    </div>
  );
};
