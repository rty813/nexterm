import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ChevronDown, ChevronRight, Folder, Search } from "lucide-react";
import type { OnekeyTargets, SessionConfig } from "../types/domain";
import { buildSessionTree, type SessionTreeNode } from "../utils/sessionTree";
import { sessionTargetSummary } from "../utils/sessionSummary";
import { appliesTo, inGroup, normalizeGroup } from "../utils/onekey";
import { useCredentials } from "../services/credentials";
import { ProtocolBadge } from "./ProtocolBadge";

export interface PickItem {
  id: string;
  label: string;
  /** Shown muted after the label (user name ...). */
  detail?: string;
  /** Shown as a warning after the label (e.g. not offered in this session). */
  note?: string;
}

/**
 * A searchable, scrolling checklist: stays usable with hundreds of entries. The search box
 * filters by label and detail; "selected only" narrows to what is ticked.
 */
export const CheckPicker: React.FC<{
  items: PickItem[];
  value: string[];
  onChange: (ids: string[]) => void;
  empty: string;
}> = ({ items, value, onChange, empty }) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [onlyPicked, setOnlyPicked] = useState(false);
  const picked = new Set(value);
  const q = query.trim().toLowerCase();
  const shown = items.filter(
    (i) => (!onlyPicked || picked.has(i.id)) && (!q || `${i.label} ${i.detail ?? ""}`.toLowerCase().includes(q))
  );
  const known = items.filter((i) => picked.has(i.id)).length;
  const set = (ids: Iterable<string>) => onChange([...new Set(ids)]);

  if (!items.length) return <p className="adv-hint">{empty}</p>;
  return (
    <div className="pick-box">
      <div className="pick-tools">
        <div className="pick-search">
          <Search size={12} />
          <input type="text" className="text-input input-sm" placeholder={t("onekey.pickSearch")} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <span className="pick-count">{t("onekey.pickCount", { n: known, total: items.length })}</span>
        <button type="button" className="btn-ghost btn-xs" onClick={() => set([...value, ...shown.map((i) => i.id)])}>
          {t("onekey.pickAll")}
        </button>
        <button type="button" className="btn-ghost btn-xs" onClick={() => set(value.filter((id) => !shown.some((i) => i.id === id)))}>
          {t("onekey.pickNone")}
        </button>
        <label className="checkbox-row pick-only">
          <input type="checkbox" checked={onlyPicked} onChange={(e) => setOnlyPicked(e.target.checked)} />
          <span>{t("onekey.pickOnlySelected")}</span>
        </label>
      </div>
      <div className="pick-list" role="listbox" aria-multiselectable="true">
        {shown.map((i) => (
          <label key={i.id} className="pick-row" role="option" aria-selected={picked.has(i.id)}>
            <input
              type="checkbox"
              checked={picked.has(i.id)}
              onChange={(e) => set(e.target.checked ? [...value, i.id] : value.filter((id) => id !== i.id))}
            />
            <span className="pick-label">{i.label}</span>
            {i.detail && <span className="pick-detail mono">{i.detail}</span>}
            {i.note && <span className="pick-note">{i.note}</span>}
          </label>
        ))}
        {!shown.length && <div className="pick-empty">{t("onekey.pickNoMatch")}</div>}
      </div>
    </div>
  );
};

/** The sessions a OneKey's targets cover. */
export function coveredSessions(sessions: SessionConfig[], value: OnekeyTargets): SessionConfig[] {
  return sessions.filter((s) => value.sessions.includes(s.id) || value.groups.some((g) => inGroup(s.group, g)));
}

/**
 * Sessions and groups a OneKey is offered in, on the session tree. Ticking a group covers
 * every session in it and its subgroups, including ones added to it later.
 */
export const SessionTargetPicker: React.FC<{
  sessions: SessionConfig[];
  value: OnekeyTargets;
  onChange: (next: OnekeyTargets) => void;
}> = ({ sessions, value, onChange }) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  // Folders start closed, except the ones holding a pick.
  const [open, setOpen] = useState<Set<string>>(() => {
    const paths = new Set<string>();
    for (const s of coveredSessions(sessions, value)) {
      const segs = normalizeGroup(s.group).split(">").filter(Boolean);
      for (let i = 1; i < segs.length + (value.sessions.includes(s.id) ? 1 : 0); i++) paths.add(segs.slice(0, i).join(">"));
    }
    return paths;
  });
  const tree = useMemo(() => buildSessionTree(sessions, query, "name"), [sessions, query]);
  const searching = Boolean(query.trim());
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);

  const groupCovered = (path: string) => value.groups.some((g) => inGroup(path, g));
  /** Covered by a ticked parent group: shown ticked, can't be unticked on its own. */
  const parentCovered = (path: string) => value.groups.some((g) => g !== normalizeGroup(path) && inGroup(path, g));
  const hasPickInside = (path: string) =>
    value.groups.some((g) => inGroup(g, path)) || value.sessions.some((id) => inGroup(byId.get(id)?.group, path));

  const toggleGroup = (path: string, on: boolean) => {
    onChange(
      on
        ? {
            // The group covers what was picked inside it.
            groups: [...value.groups.filter((g) => !inGroup(g, path)), path],
            sessions: value.sessions.filter((id) => !inGroup(byId.get(id)?.group, path)),
          }
        : { ...value, groups: value.groups.filter((g) => g !== path) }
    );
  };
  const toggleSession = (id: string, on: boolean) =>
    onChange({ ...value, sessions: on ? [...value.sessions, id] : value.sessions.filter((x) => x !== id) });

  const rows: React.ReactNode[] = [];
  const walk = (nodes: SessionTreeNode[], depth: number) => {
    for (const n of nodes) {
      const indent = { paddingLeft: 4 + depth * 16 };
      if (n.kind === "folder") {
        const covered = groupCovered(n.fullPath);
        const expanded = searching || open.has(n.fullPath);
        const partial = !covered && hasPickInside(n.fullPath);
        rows.push(
          <div key={`g:${n.fullPath}`} className="pick-row pick-tree-row" style={indent}>
            <button
              type="button"
              className="pick-twisty"
              onClick={() => setOpen((o) => {
                const next = new Set(o);
                if (next.has(n.fullPath)) next.delete(n.fullPath);
                else next.add(n.fullPath);
                return next;
              })}
              aria-label={n.name}
            >
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
            <input
              type="checkbox"
              checked={covered}
              disabled={parentCovered(n.fullPath)}
              ref={(el) => {
                if (el) el.indeterminate = partial;
              }}
              onChange={(e) => toggleGroup(n.fullPath, e.target.checked)}
              title={t("onekey.groupTip")}
            />
            <Folder size={13} className="pick-folder" />
            <span className="pick-label">{n.name}</span>
            <span className="pick-detail">{n.sessionCount}</span>
          </div>
        );
        if (expanded) walk(n.children, depth + 1);
      } else {
        const s = n.session;
        const covered = groupCovered(s.group);
        rows.push(
          <label key={`s:${s.id}`} className="pick-row pick-tree-row" style={{ paddingLeft: 4 + depth * 16 + 18 }}>
            <input type="checkbox" checked={covered || value.sessions.includes(s.id)} disabled={covered} onChange={(e) => toggleSession(s.id, e.target.checked)} />
            <ProtocolBadge protocol={s.protocol} size={12} />
            <span className="pick-label">{s.label}</span>
            <span className="pick-detail mono">{sessionTargetSummary(s)}</span>
          </label>
        );
      }
    }
  };
  walk(tree, 0);

  const knownSessions = value.sessions.filter((id) => byId.has(id)).length;
  if (!sessions.length) return <p className="adv-hint">{t("onekey.noSessions")}</p>;
  return (
    <div className="pick-box">
      <div className="pick-tools">
        <div className="pick-search">
          <Search size={12} />
          <input type="text" className="text-input input-sm" placeholder={t("onekey.pickSessionSearch")} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <span className="pick-count">
          {t("onekey.targetCount", { groups: value.groups.length, sessions: knownSessions, covered: coveredSessions(sessions, value).length })}
        </span>
        <button type="button" className="btn-ghost btn-xs" onClick={() => onChange({ sessions: [], groups: [] })}>
          {t("onekey.pickNone")}
        </button>
      </div>
      <div className="pick-list pick-tree">
        {rows}
        {!rows.length && <div className="pick-empty">{t("onekey.pickNoMatch")}</div>}
      </div>
    </div>
  );
};

/**
 * Which OneKeys one or more sessions offer: all that apply to them, or only the ones ticked.
 * OneKeys not offered in (some of) the sessions by their own "offered in" setting are listed
 * last with a note: ticking them here does not bring them in.
 */
export const SessionOnekeyChoice: React.FC<{
  sessions: Pick<SessionConfig, "id" | "group">[];
  /** null: all; [] = none. */
  value: string[] | null;
  onChange: (next: string[] | null) => void;
}> = ({ sessions, value, onChange }) => {
  const { t } = useTranslation();
  const { list } = useCredentials();
  const items = useMemo(() => {
    const keys = list.filter((c) => c.onekey);
    const offered = (c: (typeof keys)[number]) => sessions.filter((s) => appliesTo(c, s)).length;
    return keys
      .map((c) => ({ c, n: offered(c) }))
      .sort((a, b) => Number(b.n > 0) - Number(a.n > 0) || a.c.name.localeCompare(b.c.name, "zh"))
      .map<PickItem>(({ c, n }) => ({
        id: c.id,
        label: c.name,
        detail: c.username || undefined,
        note: n === sessions.length ? undefined : n === 0 ? t("onekey.notOffered") : t("onekey.partlyOffered"),
      }));
  }, [list, sessions, t]);
  const usable = items.filter((i) => !i.note).length;
  return (
    <>
      <div className="onekey-usage">
        <label className="checkbox-row">
          <input type="radio" checked={value === null} onChange={() => onChange(null)} />
          <span>{t("onekey.scopeAll", { count: usable })}</span>
        </label>
        <label className="checkbox-row">
          <input type="radio" checked={value !== null} disabled={!items.length} onChange={() => onChange(value ?? [])} />
          <span>{t("onekey.scopeOnly")}</span>
        </label>
      </div>
      {value !== null && <CheckPicker items={items} value={value} onChange={onChange} empty={t("onekey.scopeEmpty")} />}
      <p className={`adv-hint ${value !== null && !value.length ? "sync-warn" : ""}`}>
        {t(!items.length ? "onekey.scopeEmpty" : value !== null && !value.length ? "onekey.scopeNone" : "onekey.scopeHint")}
      </p>
    </>
  );
};

/** "OneKeys…" for one or more sessions of the session manager. */
export const SessionOnekeyDialog: React.FC<{
  sessions: SessionConfig[];
  onSave: (value: string[] | null) => void;
  onClose: () => void;
}> = ({ sessions, onSave, onClose }) => {
  const { t } = useTranslation();
  const keyOf = (s: SessionConfig) => (Array.isArray(s.onekeys) ? JSON.stringify([...s.onekeys].sort()) : "all");
  const mixed = new Set(sessions.map(keyOf)).size > 1;
  const [value, setValue] = useState<string[] | null>(() => (mixed ? null : sessions[0]?.onekeys ?? null));
  const title = sessions.length === 1 ? t("onekey.dialogTitleOne", { name: sessions[0].label }) : t("onekey.dialogTitle", { count: sessions.length });
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal-panel onekey-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="modal-header">
          <h3>{title}</h3>
        </div>
        <div className="modal-body">
          {mixed && <p className="adv-hint sync-warn">{t("onekey.dialogMixed")}</p>}
          <SessionOnekeyChoice sessions={sessions} value={value} onChange={setValue} />
          <div className="modal-footer">
            <button type="button" className="btn-ghost" onClick={onClose}>
              {t("sessionModal.cancel")}
            </button>
            <button type="button" className="btn-primary" onClick={() => onSave(value)}>
              {t("credentials.save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

/** Short text for a session's OneKey choice (session manager column). */
export function onekeyChoiceLabel(
  session: Pick<SessionConfig, "onekeys">,
  names: Map<string, string>,
  t: TFunction
): string {
  if (!Array.isArray(session.onekeys)) return t("onekey.cellAll");
  const known = session.onekeys.map((id) => names.get(id)).filter((n): n is string => Boolean(n));
  if (!known.length) return t("onekey.cellNone");
  return known.length <= 2 ? known.join(", ") : t("onekey.cellCount", { first: known[0], count: known.length, more: known.length - 1 });
}
