import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, ImagePlus, Pencil, Plus, Trash2, X } from "lucide-react";
import type { AppSettings, ThemeDefinition } from "../types/domain";
import { BUILTIN_THEMES } from "../constants/themes";
import { backend, isTauriRuntime } from "../services/backend";
import { backgroundImageUrl } from "../services/terminalBackground";
import { confirmAsk } from "../utils/confirm";
import {
  BACKGROUND_FITS,
  backgroundCss,
  backgroundOf,
  cloneTheme,
  colorInputValue,
  GUI_COLOR_KEYS,
  isCustomThemeId,
  normalizeHex,
  TERM_COLOR_KEYS,
  themeErrors,
  upsertTheme,
  type ThemeColorKey,
} from "../utils/themeCustom";

interface Props {
  draft: AppSettings;
  onChange: (next: AppSettings) => void;
  /** Built-in + custom themes. */
  themes: ThemeDefinition[];
  customThemes: ThemeDefinition[];
  /** Persist the custom theme list (saved at once, independent of the dialog's Save). */
  onSaveThemes: (list: ThemeDefinition[]) => Promise<void>;
}

const ANSI_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

/** Settings > Theme: color scheme gallery, custom theme editor, background image. */
export const ThemeSettings: React.FC<Props> = ({ draft, onChange, themes, customThemes, onSaveThemes }) => {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<ThemeDefinition | null>(null);
  const [error, setError] = useState("");
  const selected = themes.find((th) => th.id === draft.themeId) ?? BUILTIN_THEMES[0];
  const isCustom = (id: string) => isCustomThemeId(id, BUILTIN_THEMES);

  const startNew = () => {
    setError("");
    setEditing(cloneTheme(selected, t("themeSettings.copyName", { name: selected.name }), themes));
  };
  const startEdit = (theme: ThemeDefinition) => {
    setError("");
    setEditing({ ...theme, ansi: [...theme.ansi] as ThemeDefinition["ansi"] });
  };

  const saveEditing = async () => {
    if (!editing) return;
    const bad = themeErrors(editing);
    if (bad.length) {
      setError(bad.includes("name") ? t("themeSettings.errName") : t("themeSettings.errColor"));
      return;
    }
    const norm = (c: string) => normalizeHex(c) ?? c;
    const theme: ThemeDefinition = {
      ...editing,
      name: editing.name.trim(),
      guiBg: norm(editing.guiBg),
      guiPanel: norm(editing.guiPanel),
      guiFg: norm(editing.guiFg),
      accent: norm(editing.accent),
      termBg: norm(editing.termBg),
      termFg: norm(editing.termFg),
      cursorLocal: norm(editing.cursorLocal),
      cursorRemote: norm(editing.cursorRemote),
      ansi: editing.ansi.map(norm) as ThemeDefinition["ansi"],
    };
    try {
      await onSaveThemes(upsertTheme(customThemes, theme));
      onChange({ ...draft, themeId: theme.id });
      setEditing(null);
      setError("");
    } catch (e) {
      setError(t("themeSettings.errSave", { error: String(e) }));
    }
  };

  const remove = async (theme: ThemeDefinition) => {
    if (!(await confirmAsk(t("themeSettings.deleteConfirm", { name: theme.name })))) return;
    try {
      await onSaveThemes(customThemes.filter((th) => th.id !== theme.id));
      if (draft.themeId === theme.id) onChange({ ...draft, themeId: BUILTIN_THEMES[0].id });
      if (editing?.id === theme.id) setEditing(null);
    } catch (e) {
      setError(t("themeSettings.errSave", { error: String(e) }));
    }
  };

  const previewTheme = editing ?? selected;

  return (
    <div className="theme-settings">
      <h4 className="section-heading">{t("themeSettings.schemes")}</h4>
      <div className="theme-grid" role="radiogroup" aria-label={t("themeSettings.schemes")}>
        {themes.map((th) => (
          <div
            key={th.id}
            role="radio"
            aria-checked={th.id === selected.id}
            tabIndex={0}
            className={`theme-card ${th.id === selected.id ? "selected" : ""}`}
            onClick={() => onChange({ ...draft, themeId: th.id })}
            onKeyDown={(e) => {
              if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                onChange({ ...draft, themeId: th.id });
              }
            }}
            title={th.name}
          >
            <ThemeSwatch theme={th} />
            <div className="theme-card-footer">
              <span className="theme-card-name">{th.name}</span>
              {isCustom(th.id) && (
                <span className="theme-card-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    title={t("themeSettings.edit")}
                    onClick={(e) => {
                      e.stopPropagation();
                      startEdit(th);
                    }}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title={t("themeSettings.delete")}
                    onClick={(e) => {
                      e.stopPropagation();
                      void remove(th);
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="theme-actions">
        <button type="button" className="btn-secondary btn-sm" onClick={startNew}>
          {isCustom(selected.id) ? <Copy size={13} /> : <Plus size={13} />}
          <span>{t("themeSettings.newFrom", { name: selected.name })}</span>
        </button>
        {isCustom(selected.id) && !editing && (
          <button type="button" className="btn-secondary btn-sm" onClick={() => startEdit(selected)}>
            <Pencil size={13} />
            <span>{t("themeSettings.editSelected")}</span>
          </button>
        )}
      </div>

      {editing && (
        <ThemeEditor
          theme={editing}
          isNew={!customThemes.some((th) => th.id === editing.id)}
          error={error}
          onChange={setEditing}
          onSave={() => void saveEditing()}
          onCancel={() => {
            setEditing(null);
            setError("");
          }}
        />
      )}
      {!editing && error && <p className="lock-err">{error}</p>}

      <BackgroundSettings draft={draft} onChange={onChange} theme={previewTheme} />
    </div>
  );
};

/** Small terminal preview: background, prompt in the foreground color, ANSI swatches. */
const ThemeSwatch: React.FC<{ theme: ThemeDefinition }> = ({ theme }) => (
  <div className="theme-swatch" style={{ background: theme.termBg, color: theme.termFg }}>
    <div className="theme-swatch-bar" style={{ background: theme.guiPanel }}>
      <span style={{ background: theme.accent }} />
    </div>
    <div className="theme-swatch-text">
      <span style={{ color: theme.ansi[2] }}>user</span>
      <span style={{ color: theme.ansi[4] }}>~/src</span>
      <span>$ ls</span>
    </div>
    <div className="theme-swatch-colors">
      {theme.ansi.slice(1, 7).map((c, i) => (
        <span key={i} style={{ background: c }} />
      ))}
    </div>
  </div>
);

const ColorField: React.FC<{ label: string; value: string; onChange: (v: string) => void }> = ({ label, value, onChange }) => {
  const valid = normalizeHex(value) !== null;
  return (
    <label className="theme-color-field" title={label}>
      <input type="color" value={colorInputValue(value)} onChange={(e) => onChange(e.target.value)} />
      <span className="theme-color-label">{label}</span>
      <input
        className={`text-input theme-color-text ${valid ? "" : "invalid"}`}
        value={value}
        spellCheck={false}
        maxLength={7}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
};

const ThemeEditor: React.FC<{
  theme: ThemeDefinition;
  isNew: boolean;
  error: string;
  onChange: (theme: ThemeDefinition) => void;
  onSave: () => void;
  onCancel: () => void;
}> = ({ theme, isNew, error, onChange, onSave, onCancel }) => {
  const { t } = useTranslation();
  const set = (key: ThemeColorKey, v: string) => onChange({ ...theme, [key]: v });
  const setAnsi = (i: number, v: string) => {
    const ansi = [...theme.ansi] as ThemeDefinition["ansi"];
    ansi[i] = v;
    onChange({ ...theme, ansi });
  };
  return (
    <fieldset className="theme-editor">
      <legend>{isNew ? t("themeSettings.newTitle") : t("themeSettings.editTitle")}</legend>
      <div className="form-grid-2">
        <label className="field">
          <span>{t("themeSettings.name")}</span>
          <input className="text-input" value={theme.name} onChange={(e) => onChange({ ...theme, name: e.target.value })} />
        </label>
        <label className="checkbox-row theme-light-row">
          <input type="checkbox" checked={theme.isLight} onChange={(e) => onChange({ ...theme, isLight: e.target.checked })} />
          <span>{t("themeSettings.isLight")}</span>
        </label>
      </div>

      <div className="settings-section-title">{t("themeSettings.guiColors")}</div>
      <div className="theme-color-grid">
        {GUI_COLOR_KEYS.map((k) => (
          <ColorField key={k} label={t(`themeSettings.color.${k}`)} value={theme[k]} onChange={(v) => set(k, v)} />
        ))}
      </div>

      <div className="settings-section-title">{t("themeSettings.termColors")}</div>
      <div className="theme-color-grid">
        {TERM_COLOR_KEYS.map((k) => (
          <ColorField key={k} label={t(`themeSettings.color.${k}`)} value={theme[k]} onChange={(v) => set(k, v)} />
        ))}
      </div>

      <div className="settings-section-title">{t("themeSettings.ansiColors")}</div>
      <div className="theme-ansi-grid">
        {theme.ansi.map((c, i) => (
          <ColorField
            key={i}
            label={`${i < 8 ? "" : t("themeSettings.bright")}${t(`themeSettings.ansi.${ANSI_NAMES[i % 8]}`)}`}
            value={c}
            onChange={(v) => setAnsi(i, v)}
          />
        ))}
      </div>

      <div className="settings-section-title">{t("themeSettings.preview")}</div>
      <TerminalSample theme={theme} />

      {error && <p className="lock-err">{error}</p>}
      <div className="theme-actions">
        <button type="button" className="btn-primary btn-sm" onClick={onSave}>
          {t("themeSettings.saveTheme")}
        </button>
        <button type="button" className="btn-ghost btn-sm" onClick={onCancel}>
          {t("themeSettings.cancel")}
        </button>
      </div>
    </fieldset>
  );
};

/** A few lines of terminal text in the theme's colors. */
const TerminalSample: React.FC<{ theme: ThemeDefinition; image?: string; style?: React.CSSProperties }> = ({ theme, image, style }) => {
  const a = theme.ansi;
  return (
    <div className="theme-sample" style={{ background: theme.termBg, color: theme.termFg }}>
      {image && <div className="theme-sample-image" style={{ ...style, backgroundImage: `url("${image}")` }} />}
      <div className="theme-sample-text">
        <div>
          <span style={{ color: a[10] }}>root@server</span>:<span style={{ color: a[12] }}>~/app</span>$ ls -l
        </div>
        <div>
          <span style={{ color: a[4] }}>drwxr-xr-x</span> src <span style={{ color: a[2] }}>build.sh</span>{" "}
          <span style={{ color: a[6] }}>link</span> <span style={{ color: a[1] }}>core.dump</span>
        </div>
        <div>
          <span style={{ color: a[3] }}>WARN</span> disk 81% <span style={{ color: a[9] }}>ERROR</span> timeout{" "}
          <span style={{ color: a[5] }}>v2.1</span> <span style={{ color: a[8] }}># comment</span>
        </div>
        <div>
          $ <span className="theme-sample-cursor" style={{ background: theme.cursorLocal }} />
        </div>
      </div>
      <div className="theme-sample-colors">
        {a.map((c, i) => (
          <span key={i} style={{ background: c }} title={c} />
        ))}
      </div>
    </div>
  );
};

const BackgroundSettings: React.FC<{ draft: AppSettings; onChange: (next: AppSettings) => void; theme: ThemeDefinition }> = ({
  draft,
  onChange,
  theme,
}) => {
  const { t } = useTranslation();
  const bg = backgroundOf(draft.background);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setUrl("");
    if (bg.file) {
      backgroundImageUrl(bg.file)
        .then((u) => alive && setUrl(u))
        .catch(() => alive && setError(t("themeSettings.bgMissing")));
    }
    return () => {
      alive = false;
    };
  }, [bg.file, t]);

  const update = (patch: Partial<typeof bg>) => onChange({ ...draft, background: { ...bg, ...patch } });

  const pick = async () => {
    setError("");
    const path = await backend.pickImage(t("themeSettings.bgPick"));
    if (!path) return;
    setBusy(true);
    try {
      update({ file: await backend.importBackgroundImage(path) });
    } catch (e) {
      const msg = String(e);
      setError(msg.includes("too large") ? t("themeSettings.bgTooLarge") : msg.includes("unsupported") ? t("themeSettings.bgUnsupported") : msg);
    } finally {
      setBusy(false);
    }
  };

  const { size, repeat } = backgroundCss(bg.fit);
  return (
    <>
      <h4 className="section-heading">{t("themeSettings.background")}</h4>
      <TerminalSample
        theme={theme}
        image={url || undefined}
        style={{ opacity: bg.opacity, filter: `blur(${bg.blur}px)`, backgroundSize: size, backgroundRepeat: repeat }}
      />
      <div className="theme-actions">
        <button type="button" className="btn-secondary btn-sm" disabled={busy || !isTauriRuntime()} onClick={() => void pick()}>
          <ImagePlus size={13} />
          <span>{bg.file ? t("themeSettings.bgChange") : t("themeSettings.bgPick")}</span>
        </button>
        {bg.file && (
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => {
              setError("");
              update({ file: "" });
            }}
          >
            <X size={13} />
            <span>{t("themeSettings.bgRemove")}</span>
          </button>
        )}
      </div>
      {error && <p className="lock-err">{error}</p>}
      {bg.file && (
        <div className="form-grid-3">
          <label className="field">
            <span>
              {t("themeSettings.bgOpacity")} {Math.round(bg.opacity * 100)}%
            </span>
            <input type="range" min={0.05} max={1} step={0.05} value={bg.opacity} onChange={(e) => update({ opacity: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>
              {t("themeSettings.bgBlur")} {bg.blur}px
            </span>
            <input type="range" min={0} max={20} step={1} value={bg.blur} onChange={(e) => update({ blur: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>{t("themeSettings.bgFit")}</span>
            <select className="text-input" value={bg.fit} onChange={(e) => update({ fit: e.target.value as typeof bg.fit })}>
              {BACKGROUND_FITS.map((f) => (
                <option key={f} value={f}>
                  {t(`themeSettings.fit.${f}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <p className="adv-hint">{t("themeSettings.bgHint")}</p>
    </>
  );
};
