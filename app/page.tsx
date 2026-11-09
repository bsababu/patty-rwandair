"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, clearOfflineSession, download, operationId, Role, SessionUser, setCsrf } from "./lib/api";
import { importTemplates } from "../packages/contracts/src/import-templates";
import { mergeConsumptionLines } from "./lib/run-drafts";

type UserOption = { id: string; name: string; email: string };
type CateringRun = {
  id: string;
  name: string;
  flightNumber: string;
  serviceDate: string;
  status: string;
  version: number;
  reportingStartedAt?: string | null;
  lines?: RunLine[];
  createdBy?: { name: string };
  lead?: { id: string; name: string; email?: string } | null;
  purser?: { id: string; name: string; email?: string } | null;
  pursers?: Array<{ id: string; name: string; email?: string }>;
  metrics?: { lines?: number; loaded?: number; consumed?: number; returned?: number; spoiled?: number; discarded?: number };
  report?: { id: string; status: string; version?: number; notes?: string | null; submittedAt?: string | null; returnReason?: string | null } | null;
};
type RunLine = {
  id: string;
  loaded: number;
  consumed: number;
  returned: number;
  spoiled: number;
  discarded: number;
  remarks?: string | null;
  cabin?: string;
  item: { nameEn: string; nameFr?: string; unit?: string; sku?: string };
};
type InAppNotification = {
  id: string;
  title: string;
  body: string;
  kind: string;
  actionPath?: string | null;
  readAt?: string | null;
  createdAt: string;
};
type ReportSector = { id?: string; sequence?: number; origin: string; destination: string; scheduledDeparture?: string; scheduledArrival?: string; economyPax?: number; businessPax?: number };
type ReportDetail = {
  legacy?: boolean;
  id: string | null;
  status: string;
  version: number;
  runVersion?: number;
  notes?: string;
  submittedAt?: string | null;
  approvedAt?: string | null;
  purser?: { id?: string; name: string; email?: string } | null;
  pursers?: Array<{ id?: string | null; name: string; email?: string }>;
  flight: { id: string; flightNumber: string; serviceDate?: string; flightDate?: string; aircraft: string; status: string; sectors: ReportSector[] };
  lines: Array<{
    sector: number;
    origin: string;
    destination: string;
    cabin: string;
    sku: string;
    item: string;
    unit: string;
    loaded: number;
    consumed: number;
    returned: number;
    spoiled: number;
    discarded: number;
    unexplained: number;
    remarks?: string | null;
  }>;
  reviewHistory?: Array<{ decision: string; reason?: string | null; actorName: string; createdAt: string }>;
};

function serviceDateLabel(flight: { serviceDate?: string; flightDate?: string }) {
  return flight.serviceDate?.slice(0, 10) || flight.flightDate?.slice(0, 10) || "—";
}
const displayRole = (role: Role) => ({ ATTENDANT: "Flight Purser", LEAD: "Cabin Services", PROCUREMENT: "Catering", DIRECTOR: "Director", ADMIN: "Admin" })[role];

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    dashboard: <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></>,
    uploads: <path d="M12 16V3m-5 5 5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />,
    bell: <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    collapse: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M9 3v18m7-13-4 4 4 4" /></>,
    logout: <path d="M9 4H4v16h5m5-13 5 5-5 5M8 12h11" />,
    history: <path d="M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v5l3 2" />,
    stock: <path d="m3 7 9-4 9 4v10l-9 4-9-4V7Zm0 0 9 4 9-4m-9 4v10M7 5l9 4" />,
    users: <><circle cx="9" cy="7" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-17a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v3" /></>,
    audit: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 7h6m-6 5h6m-6 5h4" /></>,
    chart: <path d="M4 3v18h17M9 17v-5m5 5V7m5 10V4" />,
    runs: <><rect x="4" y="5" width="16" height="16" rx="3" /><path d="M8 3v4m8-4v4M4 11h16m-11 5 2 2 4-4" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.runs}</svg>;
}

function ConfirmDialog({ title, text, confirm, onConfirm, onCancel }: { title: string; text: string; confirm: string; onConfirm: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="confirmation-dialog" onCancel={onCancel} aria-labelledby="confirmation-title" aria-describedby="confirmation-text">
    <div className="confirmation-symbol"><Icon name="audit" size={24} /></div>
    <h2 id="confirmation-title">{title}</h2><p id="confirmation-text">{text}</p>
    <div className="confirmation-actions"><button className="outline" autoFocus onClick={onCancel}>Keep editing</button><button className="primary" onClick={onConfirm}>{confirm}</button></div>
  </dialog>;
}

function WorkspaceLoading() {
  return <div className="workspace-loading" role="status" aria-label="Loading workspace"><span className="loading-line" /><span className="loading-line short" /><div>{[1, 2, 3].map((item) => <span className="loading-card" key={item} />)}</div><p>Getting your workspace ready…</p></div>;
}

function NotificationInbox({ role, onNavigate }: { role: Role; onNavigate: (destination: string) => void }) {
  const inboxRef = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState<InAppNotification[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try { setItems(await api<InAppNotification[]>("/notifications")); }
    catch { /* The work area remains usable if notification refresh is unavailable. */ }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 45_000);
    return () => window.clearInterval(interval);
  }, [refresh]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (!inboxRef.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", dismiss); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [open]);
  const unread = items.filter((item) => !item.readAt).length;
  const openNotification = async (item: InAppNotification) => {
    if (!item.readAt) {
      setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, readAt: new Date().toISOString() } : entry));
      try { await api(`/notifications/${item.id}/read`, { method: "PATCH" }); } catch { void refresh(); }
    }
    setOpen(false);
    if (item.actionPath && navigation[role].includes(item.actionPath)) onNavigate(item.actionPath);
  };
  const markAllRead = async () => {
    setItems((current) => current.map((item) => item.readAt ? item : { ...item, readAt: new Date().toISOString() }));
    try { await api("/notifications/read-all", { method: "PATCH" }); } catch { void refresh(); }
  };
  return <div className="notification-inbox" ref={inboxRef}>
    <button type="button" className="notification-trigger" aria-label={unread ? `${unread} unread notifications` : "Notifications"} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <Icon name="bell" />{unread > 0 && <b>{unread > 9 ? "9+" : unread}</b>}
    </button>
    {open && <section className="notification-popover" aria-label="Notifications">
      <header><div><small>UPDATES</small><h2>Notifications</h2></div>{unread > 0 && <button type="button" onClick={() => void markAllRead()}>Mark all read</button>}</header>
      <div className="notification-list">
        {loading ? <p className="notification-empty">Checking for updates…</p> : items.length ? items.map((item) => <button type="button" key={item.id} className={item.readAt ? "notification-item" : "notification-item unread"} onClick={() => void openNotification(item)}>
          <span className="notification-dot" aria-hidden="true" /><span><b>{item.title}</b><small>{item.body}</small><em>{new Date(item.createdAt).toLocaleString()}</em></span>
        </button>) : <p className="notification-empty">You’re all caught up.</p>}
      </div>
    </section>}
  </div>;
}

function ReportPanel({ report, onClose, onDownload }: { report: ReportDetail; onClose?: () => void; onDownload?: (format: "csv" | "pdf") => void }) {
  const groups = new Map<string, { sector: number; origin: string; destination: string; cabin: string; lines: typeof report.lines }>();
  const unitTotals = new Map<string, { sector: number; cabin: string; unit: string; loaded: number; consumed: number; returned: number; spoiled: number; discarded: number; unexplained: number }>();
  for (const line of report.lines) {
    const key = `${line.sector}|${line.cabin}`;
    const group = groups.get(key) || { sector: line.sector, origin: line.origin, destination: line.destination, cabin: line.cabin, lines: [] };
    group.lines.push(line);
    groups.set(key, group);
    const unitKey = `${line.sector}|${line.cabin}|${line.unit}`;
    const unitTotal = unitTotals.get(unitKey) || { sector: line.sector, cabin: line.cabin, unit: line.unit, loaded: 0, consumed: 0, returned: 0, spoiled: 0, discarded: 0, unexplained: 0 };
    for (const field of ["loaded", "consumed", "returned", "spoiled", "discarded", "unexplained"] as const) unitTotal[field] += line[field];
    unitTotals.set(unitKey, unitTotal);
  }
  const quantityByUnit = (lines: typeof report.lines, field: "loaded" | "consumed" | "returned" | "spoiled" | "discarded" | "unexplained") => {
    const values = new Map<string, number>();
    for (const line of lines) values.set(line.unit, (values.get(line.unit) || 0) + line[field]);
    return [...values.entries()].map(([unit, value]) => `${value} ${unit}`).join(" · ") || "0";
  };
  const statusLabel = report.status.replaceAll("_", " ");
  const hasLegacyExceptions = report.lines.some((line) => line.spoiled || line.discarded || line.unexplained);
  return <section className="report-detail-panel" aria-label="Full leftovers report">
    <header className="report-heading">
      <div><span className="report-eyebrow">Full leftovers report</span><h2>{report.flight.flightNumber}</h2><p className="report-subtitle">Revision {report.version} · {report.id || "Draft"}</p></div>
      <div className="report-heading-actions"><span className="report-status"><span className="report-status-dot" />{statusLabel}</span>{onClose && <button className="report-icon-button" onClick={onClose} aria-label="Close report">×</button>}</div>
    </header>

      <div className="report-flight-summary">
      <div className="report-flight-identity"><span className="report-flight-icon" aria-hidden="true">✦</span><div><span className="report-field-label">Catering run</span><p className="report-route">{report.flight.sectors.length ? report.flight.sectors.map((sector) => `${sector.origin} → ${sector.destination}`).join(" · ") : "Run-level report"}</p></div></div>
      {onDownload && <div className="report-export-actions"><button className="report-button secondary" onClick={() => onDownload("csv")}>Download CSV</button><button className="report-button" onClick={() => onDownload("pdf")}>Download PDF</button></div>}
    </div>

    <div className="report-metadata">
      <div className="report-purser"><span className="report-avatar">FP</span><div><span className="report-field-label">Flight Pursers</span><p>{report.pursers?.length ? report.pursers.map((purser) => purser.name).join(", ") : report.purser?.name || "Flight Purser"}</p></div></div>
      <div className="report-purser"><div><span className="report-field-label">Service date</span><p>{serviceDateLabel(report.flight)}</p></div></div>
      {report.flight.aircraft && <div className="report-purser"><div><span className="report-field-label">Aircraft</span><p>{report.flight.aircraft}</p></div></div>}
    </div>

    {report.legacy && <p className="report-section-note" role="status">Historical report: some original metadata was not retained. This view uses the records available at upgrade.</p>}

    <section className="report-section" aria-labelledby="report-overview-heading">
      <div className="report-section-heading"><h3 id="report-overview-heading">At a glance</h3><span className="report-section-note">Submitted {report.submittedAt ? new Date(report.submittedAt).toLocaleString() : "Not submitted"}</span></div>
      <div className="report-overview">
        <div className="report-overview-stat"><span className="report-stat-caption">Items recorded</span><p className="report-stat-values">{report.lines.length}</p></div>
        <div className="report-overview-stat"><span className="report-stat-caption">Loaded</span><p className="report-stat-values report-stat-values-mixed">{quantityByUnit(report.lines, "loaded")}</p></div>
        <div className="report-overview-stat"><span className="report-stat-caption">Returned</span><p className="report-stat-values report-stat-values-mixed">{quantityByUnit(report.lines, "returned")}</p></div>
        {hasLegacyExceptions ? <div className="report-overview-stat"><span className="report-stat-caption">Historical exceptions</span><p className="report-stat-values report-stat-values-mixed">{quantityByUnit(report.lines, "spoiled")} spoiled · {quantityByUnit(report.lines, "discarded")} discarded · {quantityByUnit(report.lines, "unexplained")} unexplained</p></div> : <div className="report-overview-stat"><span className="report-stat-caption">Consumption</span><p className="report-stat-values report-stat-values-mixed">{quantityByUnit(report.lines, "consumed")}</p></div>}
      </div>
    </section>

    {report.flight.sectors.length > 0 && <section className="report-section" aria-labelledby="report-sectors-heading">
      <div className="report-section-heading"><h3 id="report-sectors-heading">Flight sectors</h3><span className="report-section-note">{report.flight.sectors.length} {report.flight.sectors.length === 1 ? "sector" : "sectors"}</span></div>
      <div className="report-sectors">{report.flight.sectors.map((sector, index) => <article className="report-purser" key={sector.sequence || index}>
        <div style={{ width: "100%" }}><p className="report-sector-route"><span className="report-sector-index">S{sector.sequence || index + 1}</span>{sector.origin} → {sector.destination}</p><p className="report-sector-schedule">{sector.scheduledDeparture || "Departure —"} · {sector.scheduledArrival || "Arrival —"}</p><p className="report-sector-passengers">{sector.economyPax} economy · {sector.businessPax} business passengers</p></div>
      </article>)}</div>
    </section>}

    <section className="report-items-section" aria-labelledby="report-items-heading">
      <div className="report-section-heading"><h3 id="report-items-heading">Catering details</h3><span className="report-section-note">Loaded, consumed and remaining quantities</span></div>
      {[...groups.values()].map((group) => <article className="report-item-group" key={`${group.sector}-${group.cabin}`}>
        <div className="report-group-heading"><p className="report-cabin">{report.flight.sectors.length > 0 && <>S{group.sector} · {group.origin} → {group.destination} · </>}{group.cabin === "ECONOMY" ? "Economy" : group.cabin === "BUSINESS" ? "Business" : group.cabin}</p><span className="report-count">{group.lines.length} {group.lines.length === 1 ? "item" : "items"}</span></div>
        <div className="report-line-table"><table><thead><tr><th>Item</th><th>Loaded</th><th>Consumed</th><th>Returned</th>{hasLegacyExceptions && <><th>Spoiled</th><th>Discarded</th><th>Unexplained</th></>}<th>Remarks</th></tr></thead><tbody>{group.lines.map((line, index) => <tr key={`${line.sku}-${index}`}><td><span className="report-item-code">{line.item}</span><span className="report-item-remark">{line.unit}</span></td><td className="report-number">{line.loaded}</td><td className="report-number">{line.consumed}</td><td className="report-number">{line.returned}</td>{hasLegacyExceptions && <><td className="report-number">{line.spoiled}</td><td className="report-number">{line.discarded}</td><td className="report-number">{line.unexplained}</td></>}<td>{line.remarks || "—"}</td></tr>)}</tbody></table></div>
        <div className="report-mobile-items">{group.lines.map((line, index) => <article key={`${line.sku}-mobile-${index}`}><div><span className="report-item-code">{line.item}</span><span className="report-item-remark">{line.unit}{line.remarks ? ` · ${line.remarks}` : ""}</span></div><div className="report-mobile-quantities"><span>Loaded <b>{line.loaded}</b></span><span>Consumed <b>{line.consumed}</b></span><span>Returned <b>{line.returned}</b></span>{hasLegacyExceptions && <><span>Spoiled <b>{line.spoiled}</b></span><span>Discarded <b>{line.discarded}</b></span><span>Unexplained <b>{line.unexplained}</b></span></>}</div></article>)}</div>
        <div className="report-mobile-totals"><span>Loaded {quantityByUnit(group.lines, "loaded")}</span><span>Consumed {quantityByUnit(group.lines, "consumed")}</span><span>Returned {quantityByUnit(group.lines, "returned")}</span></div>
      </article>)}
      {!report.lines.length && <p className="report-empty">No catering lines were recorded for this report.</p>}
    </section>

    <section className="report-section report-totals-section" aria-labelledby="report-totals-heading">
      <div className="report-section-heading"><h3 id="report-totals-heading">Totals by cabin and unit</h3><span className="report-section-note">Ready for reconciliation</span></div>
      <div className="report-line-table"><table><thead><tr><th>Sector / cabin</th><th>Unit</th><th>Loaded</th><th>Consumed</th><th>Returned</th>{hasLegacyExceptions && <><th>Spoiled</th><th>Discarded</th><th>Unexplained</th></>}</tr></thead><tbody>{[...unitTotals.values()].map((total) => <tr key={`${total.sector}-${total.cabin}-${total.unit}`}><td>S{total.sector} · {total.cabin}</td><td>{total.unit}</td><td className="report-number">{total.loaded}</td><td className="report-number">{total.consumed}</td><td className="report-number">{total.returned}</td>{hasLegacyExceptions && <><td className="report-number">{total.spoiled}</td><td className="report-number">{total.discarded}</td><td className="report-number">{total.unexplained}</td></>}</tr>)}</tbody></table></div>
      <div className="report-mobile-items report-mobile-total-cards">{[...unitTotals.values()].map((total) => <article key={`${total.sector}-${total.cabin}-${total.unit}-mobile`}><div><span className="report-item-code">S{total.sector} · {total.cabin}</span><span className="report-item-remark">Unit: {total.unit}</span></div><div className="report-mobile-quantities"><span>Loaded <b>{total.loaded}</b></span><span>Consumed <b>{total.consumed}</b></span><span>Returned <b>{total.returned}</b></span><span>Spoiled <b>{total.spoiled}</b></span><span>Discarded <b>{total.discarded}</b></span><span>Unexplained <b>{total.unexplained}</b></span></div></article>)}</div>
    </section>

    <div className="report-notes-and-history">
      <section className="report-notes"><h4>Run notes</h4><p>{report.notes || "No notes were added."}</p><p className="report-notes-author">Prepared from the shared Purser draft</p></section>
      {report.reviewHistory?.length ? <section className="report-history"><h4>Review history</h4>{report.reviewHistory.map((event, index) => <div key={`${event.createdAt}-${index}`}><span className="report-timeline-dot" /><div><span className="report-event-meta">{new Date(event.createdAt).toLocaleString()}</span><p><b>{event.decision}</b> · {event.actorName}{event.reason ? ` · ${event.reason}` : ""}</p></div></div>)}</section> : null}
    </div>

    <footer className="report-document-footer"><span className="report-legacy">{report.approvedAt ? `Approved ${new Date(report.approvedAt).toLocaleString()}` : "Awaiting approval"}</span><span className="report-legacy">Report ID {report.id || "Draft"}</span></footer>
  </section>;
}
type ImportType = "FLIGHTS" | "CATERING";
type AdminUser = SessionUser & {
  active: boolean;
  passwordChangedAt: string;
};
type ImportRow = {
  row: number;
  data: Record<string, string>;
  errors: string[];
};
type ImportBatch = {
  id: string;
  type: ImportType;
  status: string;
  fileName: string;
  rows?: ImportRow[];
  rowCount: number;
  errorCount: number;
  result?: Record<string, unknown> | null;
  createdAt: string;
  committedAt?: string | null;
  actor?: { name: string };
};
type Stock = {
  id: string;
  sku: string;
  name: string;
  category: string;
  onHand: number;
  reserved: number;
  available: number;
  reorderPoint: number;
  status: string;
  priceMinor: number;
  currency: string;
};
type WasteSummary = {
  currency: string;
  totalMinor: number;
  byReason: Array<{ reason: string; quantity: number; amountMinor: number }>;
  byCategory: Array<{ category: string; amountMinor: number }>;
};
type OperationalSummary = {
  forwarded: number;
  approved: number;
  loaded: number;
  consumed: number;
  returned: number;
  consumptionRate: number;
  returnRate: number;
  recent: Array<{ id: string; flightNumber: string; serviceDate: string; status: string; consumed: number; returned: number }>;
};

const words = {
  EN: {
    workspace: "workspace",
    signOut: "Sign out",
    search: "Search this page…",
    welcome: "Welcome back",
    loginText: "Sign in with your RwandAir workspace account.",
    email: "Work email",
    password: "Password",
    signin: "Sign in securely",
    flights: "Flights",
    passengers: "Passengers",
    status: "Status",
    save: "Save draft",
    submit: "Submit final report",
    consumed: "Consumed",
    returned: "Returned",
    spoiled: "Spoiled",
    discarded: "Discarded",
    variance: "Variance",
    notes: "Purser notes",
    approved: "Approve",
    return: "Return",
    stock: "Stock position",
    loading: "Loading secure workspace…",
    retry: "Retry",
    empty: "Nothing needs attention.",
  },
  FR: {
    workspace: "espace",
    signOut: "Déconnexion",
    search: "Rechercher sur cette page…",
    welcome: "Bienvenue",
    loginText: "Connectez-vous avec votre compte professionnel RwandAir.",
    email: "E-mail professionnel",
    password: "Mot de passe",
    signin: "Connexion sécurisée",
    flights: "Vols",
    passengers: "Passagers",
    status: "Statut",
    save: "Enregistrer le brouillon",
    submit: "Soumettre le rapport final",
    consumed: "Consommé",
    returned: "Retourné",
    spoiled: "Gaspillé",
    discarded: "Écarté",
    variance: "Écart",
    notes: "Notes du chef de cabine",
    approved: "Approuver",
    return: "Retourner",
    stock: "Position du stock",
    loading: "Chargement de l’espace sécurisé…",
    retry: "Réessayer",
    empty: "Aucune action requise.",
  },
} as const;
const navigation: Record<Role, string[]> = {
  ATTENDANT: ["my-runs", "history"],
  LEAD: ["operations"],
  PROCUREMENT: ["dashboard", "uploads", "reconciliation", "stock", "waste"],
  DIRECTOR: ["executive", "costs", "insights"],
  ADMIN: ["users", "audit"],
};
const labels: Record<string, { EN: string; FR: string }> = {
  "my-runs": { EN: "My runs", FR: "Mes services" },
  history: { EN: "Run history", FR: "Historique des services" },
  operations: { EN: "Catering runs", FR: "Services catering" },
  attendants: { EN: "Flight Purser", FR: "Chef de cabine" },
  catering: { EN: "Assign catering", FR: "Affecter le catering" },
  "load-planning": { EN: "Load planning", FR: "Plan de chargement" },
  reports: { EN: "Catering reports", FR: "Rapports catering" },
  dashboard: { EN: "Dashboard", FR: "Tableau de bord" },
  uploads: { EN: "Upload data", FR: "Importer des données" },
  reconciliation: { EN: "Reconciliation", FR: "Rapprochement" },
  stock: { EN: "Stock", FR: "Stock" },
  waste: { EN: "Waste analysis", FR: "Analyse des pertes" },
  suppliers: { EN: "Suppliers", FR: "Fournisseurs" },
  executive: { EN: "Executive view", FR: "Vue exécutive" },
  costs: { EN: "Cost analytics", FR: "Analyse des coûts" },
  insights: { EN: "Insights", FR: "Perspectives" },
  users: { EN: "Users", FR: "Utilisateurs" },
  audit: { EN: "Audit", FR: "Audit" },
};
const fmt = (n: number) => new Intl.NumberFormat("en-RW").format(n);
const money = (n: number) =>
  new Intl.NumberFormat("en-RW", {
    style: "currency",
    currency: "RWF",
    maximumFractionDigits: 0,
  }).format(n);
const demoPersonasEnabled =
  process.env.NEXT_PUBLIC_DEMO_PERSONAS === "true";

function Login({
  onSuccess,
  lang,
}: {
  onSuccess: (u: SessionUser) => void;
  lang: "EN" | "FR";
}) {
  const t = words[lang],
    [email, setEmail] = useState(
      demoPersonasEnabled ? "attendant@wings.rw" : "",
    ),
    [password, setPassword] = useState(
      demoPersonasEnabled ? "Wings2026!" : "",
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ user: SessionUser; csrf: string }>(
        "/auth/login",
        { method: "POST", body: JSON.stringify({ email, password }) },
      );
      setCsrf(result.csrf, result.user);
      onSuccess(result.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to sign in");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <section className="login-story">
        <div className="rw-bar" />
        <div className="login-brand">
          <div className="rw-logo" aria-label="RwandAir" />
          <span>
            RwandAir<small>Catering Control</small>
          </span>
        </div>
        <div className="story-copy">
          <span>RWANDAIR CATERING CONTROL</span>
          <h1>
            Every run.
            <br />
            Better supplied.
            <br />
            <em>Fully accounted.</em>
          </h1>
          <p>
            One operational view from catering load to post-flight
            reconciliation, built for the teams who keep RwandAir moving.
          </p>
          <div className="login-workflow"><span>Prepare</span><i>→</i><span>Serve</span><i>→</i><span>Account</span></div>
        </div>
        <footer>Kigali · Rwanda · Secure operations workspace</footer>
      </section>
      <section className="login-form">
        <form onSubmit={submit}>
          <span className="secure">● SECURE STAFF ACCESS</span>
          <h2>{t.welcome}</h2>
          <p>{t.loginText}</p>
          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}
          <label>
            {t.email}
            <input
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label>
            {t.password}
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <button className="primary" disabled={busy}>
            {busy ? "Authenticating…" : t.signin + " →"}
          </button>
          {demoPersonasEnabled && <div className="demo">
            <small>DEVELOPMENT ACCOUNTS</small>
            <select onChange={(e) => setEmail(e.target.value)} value={email}>
              <option value="attendant@wings.rw">Flight Purser</option>
              <option value="lead@wings.rw">Cabin Services</option>
              <option value="procurement@wings.rw">Catering</option>
              <option value="director@wings.rw">Director</option>
              <option value="admin@wings.rw">Administrator</option>
            </select>
          </div>}
          <p className="privacy">
            Protected by role authorization, CSRF defense and an immutable audit
            trail.
          </p>
        </form>
      </section>
    </main>
  );
}

function PageTitle({
  eyebrow,
  title,
  text,
  action,
}: {
  eyebrow: string;
  title: string;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <small>{eyebrow}</small>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
      {action}
    </div>
  );
}
function Kpi({
  label,
  value,
  note,
  tone = "",
}: {
  label: string;
  value: string;
  note: string;
  tone?: string;
}) {
  return (
    <article className={"metric " + tone}>
      <small>{label}</small>
      <strong className={value.length > 8 ? "metric-value-long" : undefined}>{value}</strong>
      <span>{note}</span>
    </article>
  );
}
function ErrorState({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <div className="card empty" role="alert">
      {message}{" "}
      {retry && (
        <button className="link" onClick={retry}>
          Retry
        </button>
      )}
    </div>
  );
}

function RunAttendant({ active, onDirtyChange }: { active: string; onDirtyChange: (dirty: boolean) => void }) {
  const [runs, setRuns] = useState<CateringRun[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [runSearch, setRunSearch] = useState("");
  const [itemSearch, setItemSearch] = useState("");
  const [runSort, setRunSort] = useState<"date-desc" | "date-asc" | "flight">("date-desc");
  const [itemSort, setItemSort] = useState<"name" | "loaded" | "consumed" | "returned">("name");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pendingRun, setPendingRun] = useState<string | null>(null);
  const [dateFilter, setDateFilter] = useState("");
  const [remarkOpen, setRemarkOpen] = useState<string[]>([]);
  const [savedLines, setSavedLines] = useState(new Map<string, RunLine[]>());
  const [conflictRun, setConflictRun] = useState<CateringRun | null>(null);
  const [conflictChoices, setConflictChoices] = useState<Record<string, "mine" | "server">>({});
  const [saveConflict, setSaveConflict] = useState(false);
  const load = useCallback(async () => {
    try {
      const rows = await api<CateringRun[]>("/runs");
      setRuns(rows);
      setSavedLines(new Map(rows.map((run) => [run.id, run.lines || []])));
      setSelectedId((current) => current || rows[0]?.id || "");
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Catering runs failed to load");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [dirty]);
  const isClosed = (run: CateringRun) => run.status === "CANCELLED" || ["FORWARDED", "APPROVED", "REJECTED"].includes(run.report?.status || "");
  const visibleRuns = runs
    .filter((run) => active === "history" ? isClosed(run) : !isClosed(run))
    .filter((run) => !dateFilter || run.serviceDate.slice(0, 10) === dateFilter)
    .filter((run) => `${run.flightNumber} ${run.name} ${run.serviceDate}`.toLowerCase().includes(runSearch.trim().toLowerCase()))
    .sort((left, right) => runSort === "flight"
      ? left.flightNumber.localeCompare(right.flightNumber)
      : runSort === "date-asc"
        ? left.serviceDate.localeCompare(right.serviceDate)
        : right.serviceDate.localeCompare(left.serviceDate));
  const selected = runs.find((run) => run.id === selectedId) || null;
  useEffect(() => {
    const candidates = runs.filter((run) => active === "history" ? isClosed(run) : !isClosed(run));
    if (!candidates.some((run) => run.id === selectedId)) setSelectedId(candidates[0]?.id || "");
  }, [active, selectedId, runs]);
  const closed = selected ? isClosed(selected) : false;
  const merge = conflictRun && selected ? mergeConsumptionLines(savedLines.get(selected.id) || [], selected.lines || [], conflictRun.lines || []) : null;
  async function reviewServerChanges() {
    if (!selected) return;
    setBusy(true);
    try {
      const latest = (await api<CateringRun[]>("/runs")).find((run) => run.id === selected.id);
      if (!latest) throw new Error("This run is no longer assigned to you. Your unsaved entries remain on this page.");
      setConflictRun(latest); setConflictChoices({});
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not retrieve server changes"); }
    finally { setBusy(false); }
  }
  function applyReviewedChanges() {
    if (!conflictRun || !merge) return;
    const lines = merge.lines.map((line) => {
      const resolved = { ...line };
      for (const conflict of merge.conflicts.filter((entry) => entry.id === line.id)) {
        if (conflictChoices[`${line.id}:${conflict.field}`] === "mine") Object.assign(resolved, { [conflict.field]: conflict.local });
      }
      return resolved;
    });
    setSavedLines((current) => new Map(current).set(conflictRun.id, conflictRun.lines || []));
    setRuns((current) => current.map((run) => run.id === conflictRun.id ? { ...conflictRun, lines } : run));
    setConflictRun(null); setSaveConflict(false); setDirty(true); setError(""); setNotice("Changes merged. Check the quantities, then save consumption.");
  }
  const displayedLines = (selected?.lines || [])
    .filter((line) => `${line.item.nameEn} ${line.item.nameFr || ""} ${line.item.sku || ""} ${line.item.unit || ""}`.toLowerCase().includes(itemSearch.trim().toLowerCase()))
    .sort((left, right) => {
      if (itemSort === "name") return left.item.nameEn.localeCompare(right.item.nameEn);
      if (itemSort === "loaded") return right.loaded - left.loaded;
      if (itemSort === "consumed") return right.consumed - left.consumed;
      return (right.loaded - right.consumed) - (left.loaded - left.consumed);
    });
  const totals = (selected?.lines || []).reduce((sum, line) => ({
    loaded: sum.loaded + line.loaded,
    consumed: sum.consumed + line.consumed,
    returned: sum.returned + Math.max(0, line.loaded - line.consumed),
  }), { loaded: 0, consumed: 0, returned: 0 });
  function updateLine(id: string, field: "consumed" | "remarks", value: string) {
    setDirty(true);
    setRuns((current) => current.map((run) => run.id !== selectedId ? run : { ...run, lines: (run.lines || []).map((line) => line.id !== id ? line : { ...line, [field]: field === "remarks" ? value : Math.min(line.loaded, Math.max(0, Math.trunc(Number(value) || 0))) }) }));
  }
  async function save() {
    if (!selected) return null;
    setError(""); setNotice("");
    setBusy(true);
    try {
      const result = await api<{ version: number }>(`/runs/${selected.id}/draft`, { method: "PATCH", body: JSON.stringify({ version: selected.version, lines: (selected.lines || []).map((line) => ({ id: line.id, consumed: line.consumed, remarks: line.remarks || "" })) }) });
      setSavedLines((current) => new Map(current).set(selected.id, selected.lines || []));
      setRuns((current) => current.map((run) => run.id === selected.id ? { ...run, version: result.version, reportingStartedAt: run.reportingStartedAt || new Date().toISOString() } : run));
      setDirty(false);
      setSaveConflict(false); setConflictRun(null);
      setNotice("Consumption saved. Returned quantities were calculated automatically.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Draft save failed");
      if ((e as { status?: number }).status === 409) { setSaveConflict(true); await reviewServerChanges(); }
      return null;
    }
    finally { setBusy(false); }
  }
  async function exportReport(format: "csv" | "pdf") {
    if (!selected) return;
    try {
      const result = await download(`/runs/${selected.id}/report.${format}`);
      const url = URL.createObjectURL(result.blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = result.fileName; anchor.click(); URL.revokeObjectURL(url);
    } catch (e) { setError(e instanceof Error ? e.message : "Report export failed"); }
  }
  function selectRun(id: string) {
    if (id === selectedId) return;
    if (dirty) { setPendingRun(id); return; }
    setSelectedId(id); setItemSearch(""); setNotice(""); setRemarkOpen([]); setConflictRun(null); setSaveConflict(false);
  }
  if (loading) return <WorkspaceLoading />;
  if (error && !runs.length) return <ErrorState message={error} retry={load} />;
  return <>
    <PageTitle eyebrow={active === "history" ? "RUN HISTORY" : "CATERING RUNS"} title={active === "history" ? "Completed catering runs" : "My assigned catering runs"} text={active === "history" ? "Search and review your completed service history." : "Record consumption only. Returned quantities are calculated from the loaded total."} />
    {pendingRun !== null && <ConfirmDialog title="You have unsaved consumption" text="Save your current run before switching, or discard these changes and open the other run." confirm="Discard and switch" onCancel={() => setPendingRun(null)} onConfirm={() => { setDirty(false); setSelectedId(pendingRun); setPendingRun(null); setItemSearch(""); void load(); }} />}
    {error && <div className="error-box" role="alert">{error}</div>}{notice && <div className="success-box" role="status">{notice}</div>}
    {selected?.report?.returnReason && <div className="correction-note" role="status"><b>Catering requested a correction</b><p>{selected.report.returnReason}</p></div>}
    {saveConflict && !conflictRun && <button className="outline" disabled={busy} onClick={() => void reviewServerChanges()}>Review server changes</button>}
    {conflictRun && merge && <section className="card draft-conflict" aria-label="Review shared draft changes"><h2>Another team member updated this run</h2><p>Your entries are still here. Independent changes can be merged; choose which values to keep where both people edited the same field.</p>
      {isClosed(conflictRun) ? <p>This run is now closed. Your unsaved values remain visible below, but can no longer be saved.</p> : <>{merge.conflicts.map((entry) => <label key={`${entry.id}:${entry.field}`}><span>{conflictRun.lines?.find((line) => line.id === entry.id)?.item.nameEn} · {entry.field}</span><select aria-label={`Resolve ${entry.field} for ${entry.id}`} value={conflictChoices[`${entry.id}:${entry.field}`] || ""} onChange={(event) => setConflictChoices((current) => ({ ...current, [`${entry.id}:${entry.field}`]: event.target.value as "mine" | "server" }))}><option value="">Choose a value…</option><option value="server">Team value: {entry.server || "(blank)"}</option><option value="mine">My value: {entry.local || "(blank)"}</option></select></label>)}<button className="primary" disabled={merge.conflicts.some((entry) => !conflictChoices[`${entry.id}:${entry.field}`])} onClick={applyReviewedChanges}>Apply reviewed changes</button></>}
    </section>}
    <section className="purser-run-shell">
      <aside className="card purser-run-list" aria-label="Assigned catering runs">
        <div className="purser-list-head"><div><small>{visibleRuns.length} RUNS</small><h2>{active === "history" ? "History" : "To complete"}</h2></div><span className="badge">{runs.length}</span></div>
        <label className="purser-search"><span aria-hidden="true">⌕</span><input aria-label="Search assigned runs" placeholder="Search flight or date" value={runSearch} onChange={(event) => setRunSearch(event.target.value)} /></label>
        <div className="purser-list-tools"><label><span>Sort</span><select aria-label="Sort assigned runs" value={runSort} onChange={(event) => setRunSort(event.target.value as typeof runSort)}><option value="date-desc">Newest first</option><option value="date-asc">Oldest first</option><option value="flight">Flight number</option></select></label><label><span>Service date</span><input type="date" aria-label="Filter assigned runs by date" value={dateFilter} onChange={(event) => setDateFilter(event.target.value)} /></label>{dateFilter && <button className="link" onClick={() => setDateFilter("")}>Clear date</button>}</div>
        <div className="purser-run-items">{visibleRuns.map((run) => <button className={run.id === selectedId ? "purser-run-item selected" : "purser-run-item"} key={run.id} onClick={() => selectRun(run.id)} aria-pressed={run.id === selectedId}><span><b>{run.flightNumber}</b><small>{run.serviceDate} · {run.lines?.length || 0} items</small></span><em className={`flight-stage ${run.report?.status === "APPROVED" ? "good" : "active"}`}>{run.report?.status === "FORWARDED" ? "In review" : run.report?.status === "APPROVED" ? "Approved" : "Draft"}</em></button>)}{!visibleRuns.length && <div className="empty">No runs match this search.</div>}</div>
      </aside>
      {!selected ? <div className="card empty">No catering runs are assigned to you.</div> : <section className="card purser-editor">
        <header className="purser-editor-head"><div><small>ASSIGNED RUN · {selected.flightNumber}</small><h2>{selected.name}</h2><p>{selected.serviceDate} · {closed ? "Read-only after Catering receives the report." : "Enter consumed quantities only; returned is calculated automatically."}</p></div><div className="purser-editor-actions">{dirty && <span className="unsaved-badge">Unsaved changes</span>}{selected.report && <><button className="outline compact" onClick={() => void exportReport("csv")}>CSV</button><button className="outline compact" onClick={() => void exportReport("pdf")}>PDF</button></>}</div></header>
        <div className="purser-total-strip"><span><small>Loaded</small><b>{totals.loaded}</b></span><span><small>Consumed</small><b>{totals.consumed}</b></span><span><small>Auto-returned</small><b>{totals.returned}</b></span><span><small>Items</small><b>{selected.lines?.length || 0}</b></span></div>
        <div className="purser-item-toolbar"><label className="purser-search"><span aria-hidden="true">⌕</span><input aria-label="Search catering items" placeholder="Search item, SKU or unit" value={itemSearch} onChange={(event) => setItemSearch(event.target.value)} /></label><label><span>Sort items</span><select aria-label="Sort catering items" value={itemSort} onChange={(event) => setItemSort(event.target.value as typeof itemSort)}><option value="name">Name</option><option value="loaded">Loaded quantity</option><option value="consumed">Consumed quantity</option><option value="returned">Returned quantity</option></select></label><span className="item-count">Showing {displayedLines.length} of {selected.lines?.length || 0}</span></div>
        <div className="purser-item-table-wrap"><table className="purser-item-table"><thead><tr><th>Item</th><th>Loaded</th><th>Consumed</th><th>Remaining</th><th>Remarks</th></tr></thead><tbody>{displayedLines.map((line) => <tr key={line.id}>
          <td><b>{line.item.nameEn}</b><small>{line.item.unit || "Catering item"}</small></td>
          <td className="quantity-readonly" data-label="Loaded">{line.loaded}</td>
          <td data-label="Consumed"><label className="sr-only" htmlFor={`consumed-${line.id}`}>Consumed for {line.item.nameEn}</label><input id={`consumed-${line.id}`} className="purser-consumed-input" type="number" inputMode="numeric" min={0} max={line.loaded} disabled={closed || busy} value={line.consumed} onChange={(event) => updateLine(line.id, "consumed", event.target.value)} /></td>
          <td className="quantity-derived" data-label="Remaining">{Math.max(0, line.loaded - line.consumed)}</td>
          <td className="remark-cell">{line.remarks || remarkOpen.includes(line.id) ? <><label className="sr-only" htmlFor={`remark-${line.id}`}>Remark for {line.item.nameEn}</label><input id={`remark-${line.id}`} className="purser-remark-input" value={line.remarks || ""} disabled={closed || busy} placeholder="Optional remark" onChange={(event) => updateLine(line.id, "remarks", event.target.value)} /></> : <button className="add-remark" disabled={closed || busy} aria-label={`Add remark for ${line.item.nameEn}`} onClick={() => setRemarkOpen((current) => [...current, line.id])}>+ Add remark</button>}</td>
        </tr>)}</tbody></table>{!displayedLines.length && <div className="empty">No catering items match this search.</div>}</div>
        <footer className="purser-editor-footer"><span>{closed ? "This run is closed for editing." : "Saving updates the shared run draft. Cabin Services generates the final report."}</span><button className="primary" disabled={busy || closed || saveConflict || (!dirty && Boolean(selected.reportingStartedAt))} onClick={() => void save()}>{busy ? "Saving…" : dirty || !selected.reportingStartedAt ? "Save consumption" : "Saved"}</button></footer>
      </section>}
    </section>
  </>;
}

function LeadReportPreview({ report, onDownload }: { report: ReportDetail; onDownload: (format: "csv" | "pdf") => void }) {
  const fullPreview = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (window.matchMedia("(max-width: 720px)").matches) fullPreview.current?.showModal();
  }, []);
  const totals = report.lines.reduce((sum, line) => ({ loaded: sum.loaded + line.loaded, consumed: sum.consumed + line.consumed, returned: sum.returned + line.returned }), { loaded: 0, consumed: 0, returned: 0 });
  return <aside className="lead-report-preview" aria-label="Report preview">
    <div className="lead-preview-head"><div><small>REPORT PREVIEW</small><h2>{report.flight.flightNumber}</h2><p>{serviceDateLabel(report.flight)} · {report.lines.length} items</p></div><span className="run-status ready">{report.status.replaceAll("_", " ")}</span></div>
    <div className="lead-preview-totals"><span><small>Loaded</small><b>{totals.loaded}</b></span><span><small>Consumed</small><b>{totals.consumed}</b></span><span><small>Returned</small><b>{totals.returned}</b></span></div>
    <div className="lead-preview-lines">{report.lines.map((line, index) => <article key={`${line.sku}-${index}`}><div><b>{line.item}</b><span>{line.unit}</span>{line.remarks && <small>{line.remarks}</small>}</div><strong>{line.consumed} consumed<br /><em>{line.returned} returned</em></strong></article>)}</div>
    <button className="outline full-preview-button" onClick={() => fullPreview.current?.showModal()}>Open full preview ↗</button>
    <div className="lead-preview-actions"><button className="outline compact" onClick={() => onDownload("csv")}>Download CSV</button><button className="outline compact" onClick={() => onDownload("pdf")}>Download PDF</button></div>
    <dialog ref={fullPreview} className="full-report-dialog" aria-label="Full report preview"><ReportPanel report={report} onClose={() => fullPreview.current?.close()} onDownload={onDownload} /></dialog>
  </aside>;
}

function RunLead() {
  const [runs, setRuns] = useState<CateringRun[]>([]);
  const [attendants, setAttendants] = useState<UserOption[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [preview, setPreview] = useState<ReportDetail | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [runView, setRunView] = useState("active");
  const [serviceDate, setServiceDate] = useState("");
  const [workspaceTab, setWorkspaceTab] = useState("Overview");
  const [confirmSend, setConfirmSend] = useState(false);
  const load = useCallback(async () => {
    try {
      const [runRows, attendantRows] = await Promise.all([api<CateringRun[]>("/runs"), api<UserOption[]>("/lead/attendants")]);
      setRuns(runRows);
      setAttendants(attendantRows);
      setSelectedId((current) => current || runRows[0]?.id || "");
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Catering runs failed to load"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const selected = runs.find((run) => run.id === selectedId) || null;
  const pursersFor = (run: CateringRun) => run.pursers?.length ? run.pursers : run.purser ? [run.purser] : [];
  const metricsFor = (run: CateringRun) => (run.lines || []).reduce((totals, line) => ({ lines: totals.lines + 1, loaded: totals.loaded + line.loaded, consumed: totals.consumed + line.consumed, returned: totals.returned + Math.max(0, line.loaded - line.consumed) }), { lines: 0, loaded: 0, consumed: 0, returned: 0 });
  const canGenerate = (run: CateringRun) => Boolean(run.status !== "CANCELLED" && run.reportingStartedAt && run.lines?.length && pursersFor(run).length && !["FORWARDED", "APPROVED", "REJECTED"].includes(run.report?.status || ""));
  const visibleRuns = runs.filter((run) => (runView === "all" || (runView === "history" ? run.status === "CANCELLED" || ["FORWARDED", "APPROVED", "REJECTED"].includes(run.report?.status || "") : run.status !== "CANCELLED" && !["FORWARDED", "APPROVED", "REJECTED"].includes(run.report?.status || ""))) && (!serviceDate || run.serviceDate.slice(0, 10) === serviceDate) && `${run.flightNumber} ${run.serviceDate} ${run.name}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.serviceDate.localeCompare(a.serviceDate));
  useEffect(() => {
    const refresh = () => { void load(); };
    const timer = window.setInterval(refresh, 20_000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [load]);
  useEffect(() => {
    if (visibleRuns.some((run) => run.id === selectedId) || (!visibleRuns.length && !selectedId)) return;
    setSelectedId(visibleRuns[0]?.id || ""); setPreview(null);
  }, [visibleRuns, selectedId]);
  async function assignPurser(runId: string, purserId: string) {
    if (!purserId) return;
    setBusy(true);
    try {
      const version = runs.find((run) => run.id === runId)?.version;
      await api(`/runs/${runId}/pursers`, { method: "POST", body: JSON.stringify({ purserId, version }) });
      setNotice("Flight Purser added to this catering run.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Purser assignment failed"); }
    finally { setBusy(false); }
  }
  async function removePurser(runId: string, purserId: string) {
    setBusy(true);
    try {
      const version = runs.find((run) => run.id === runId)?.version;
      await api(`/runs/${runId}/pursers/${purserId}`, { method: "DELETE", body: JSON.stringify({ version }) });
      setNotice("Flight Purser removed from this catering run.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Purser removal failed"); }
    finally { setBusy(false); }
  }
  async function previewReport(runId: string) {
    setBusy(true);
    try { setPreview(await api<ReportDetail>(`/runs/${runId}/report/preview`)); await load(); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Report preview failed"); }
    finally { setBusy(false); }
  }
  async function sendToCatering(runId: string) {
    if (!preview || preview.flight.id !== runId) return;
    setBusy(true);
    try {
      const report = await api<ReportDetail>(`/runs/${runId}/report`, { method: "POST", body: JSON.stringify({ operationId: operationId(), runVersion: preview.runVersion }) });
      setPreview(report);
      setNotice("Report sent to Catering for review.");
      await load();
    } catch (e) { if ((e as { status?: number }).status === 409) setPreview(null); setError(e instanceof Error ? e.message : "Could not send report to Catering"); }
    finally { setBusy(false); }
  }
  async function exportReport(runId: string, format: "csv" | "pdf") {
    try {
      const result = await download(`/runs/${runId}/report.${format}`);
      const url = URL.createObjectURL(result.blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = result.fileName; anchor.click(); URL.revokeObjectURL(url);
    } catch (e) { setError(e instanceof Error ? e.message : "Report download failed"); }
  }
  if (error && !runs.length) return <ErrorState message={error} retry={load} />;
  if (loading) return <WorkspaceLoading />;
  return <>
    <PageTitle eyebrow="CABIN SERVICES" title="Catering run review" text="Assign the Pursers needed for service, check the live consumption, then preview and send one report to Catering." />
    {error && <div className="error-box" role="alert">{error}</div>}{notice && <div className="success-box">{notice}</div>}
    <div className="workspace-toolbar">
      <div className="segmented-control" aria-label="Filter catering runs">{[["active", "Active"], ["history", "History"], ["all", "All runs"]].map(([value, label]) => <button key={value} aria-pressed={runView === value} onClick={() => setRunView(value)}>{label}</button>)}</div>
      <label className="workspace-search"><span aria-hidden="true">⌕</span><input aria-label="Search catering runs" placeholder="Search flight or run…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <input type="date" aria-label="Filter catering runs by date" value={serviceDate} onChange={(event) => setServiceDate(event.target.value)} />{serviceDate && <button className="link" onClick={() => setServiceDate("")}>Clear date</button>}
    </div>
    <section className="lead-run-picker" aria-label="Assigned catering runs">{visibleRuns.map((run) => <button className={run.id === selectedId ? "run-picker-item selected" : "run-picker-item"} key={run.id} aria-pressed={run.id === selectedId} onClick={() => { setSelectedId(run.id); setPreview(null); setWorkspaceTab("Overview"); }}><Icon name="runs" /><span><b>{run.flightNumber}</b><small>{run.serviceDate} · {run.lines?.length || 0} items</small></span><em className="run-status">{run.report?.status === "FORWARDED" ? "In review" : run.report?.status === "APPROVED" ? "Approved" : !pursersFor(run).length ? "Needs team" : "In progress"}</em></button>)}{!visibleRuns.length && <div className="card empty">{runs.length ? "No runs match these filters." : "No assignments yet. Catering will assign your runs here."}</div>}</section>
    {selected?.report?.returnReason && <div className="correction-note" role="status"><b>Catering requested a correction</b><p>{selected.report.returnReason}</p></div>}
    {selected && <section className="lead-run-layout">
      <div className="card run-lead-workspace">
        <div className="card-head"><div><small>CATERING WORKSPACE</small><h2>{selected.flightNumber}</h2><p className="dashboard-section-copy">{selected.serviceDate} · {selected.lines?.length || 0} items · {pursersFor(selected).length} Pursers</p></div><span className="run-status">{selected.report?.status?.replaceAll("_", " ") || "Draft"}</span></div>
        <div className="workspace-tabs" aria-label="Run sections">{["Overview", "Team", "Consumption", "Report"].map((tab) => <button key={tab} aria-pressed={workspaceTab === tab} onClick={() => setWorkspaceTab(tab)}>{tab}</button>)}</div>
        {["Overview", "Consumption"].includes(workspaceTab) && <><div className="run-metrics" aria-label="Run metrics">{([['Items', metricsFor(selected).lines], ['Loaded', metricsFor(selected).loaded], ['Consumed', metricsFor(selected).consumed], ['Remaining', metricsFor(selected).returned]] as Array<[string, number]>).map(([label, value]) => <div className="run-metric" key={label}><span>{label}</span><b>{value}</b></div>)}</div><div className="consumption-progress"><span>Consumption</span><b>{metricsFor(selected).loaded ? Math.round(metricsFor(selected).consumed / metricsFor(selected).loaded * 100) : 0}%</b><progress aria-label="Run consumption" value={metricsFor(selected).consumed} max={metricsFor(selected).loaded || 1} /></div></>}
        {["Overview", "Team"].includes(workspaceTab) && <div className="run-assignment-panel"><div><span className="run-panel-label">Assigned Flight Pursers</span><p className="dashboard-section-copy">Your team records consumption in one shared draft.</p><div className="run-purser-list">{pursersFor(selected).map((purser) => <span className="run-purser-chip" key={purser.id}>{purser.name}<button type="button" aria-label={`Remove ${purser.name}`} disabled={busy || Boolean(selected.report)} onClick={() => void removePurser(selected.id, purser.id)}>×</button></span>)}{!pursersFor(selected).length && <span className="empty-inline">Assign a Purser to get started.</span>}</div></div><label className="run-purser-add">Add Purser<select aria-label={`Add Flight Purser to ${selected.name}`} disabled={busy || Boolean(selected.report)} value="" onChange={(event) => void assignPurser(selected.id, event.target.value)}><option value="">Select a Purser…</option>{attendants.filter((attendant) => !pursersFor(selected).some((purser) => purser.id === attendant.id)).map((attendant) => <option key={attendant.id} value={attendant.id}>{attendant.name}</option>)}</select></label></div>}
        {workspaceTab === "Consumption" && <div className="lead-consumption-list">{(selected.lines || []).map((line) => <article key={line.id}><div><b>{line.item.nameEn}</b><small>{line.loaded} loaded · {line.item.unit}</small>{line.remarks && <p>{line.remarks}</p>}</div><span><b>{line.consumed}</b> consumed<small>{line.loaded - line.consumed} remaining</small></span></article>)}</div>}
        {["Overview", "Report"].includes(workspaceTab) && <>{selected.report && ["FORWARDED", "APPROVED"].includes(selected.report.status) && <div className="report-receipt"><Icon name="audit" /><div><b>{selected.report.status === "APPROVED" ? "Approved by Catering" : "Report sent to Catering"}</b><span>{selected.report.submittedAt ? new Date(selected.report.submittedAt).toLocaleString() : "Your report is available for review."}</span></div></div>}<div className="lead-report-actions"><button className="outline" disabled={busy || !selected.lines?.length} onClick={() => void previewReport(selected.id)}>{busy ? "Loading…" : "Preview report"}</button><button className="primary" disabled={busy || !canGenerate(selected) || preview?.flight.id !== selected.id} onClick={() => setConfirmSend(true)}>Send to Catering →</button></div><p className="run-report-hint">Review the preview before sending your final report.</p></>}
      </div>
      {preview?.flight.id === selected.id ? <LeadReportPreview report={preview} onDownload={(format) => void exportReport(selected.id, format)} /> : <aside className="card lead-preview-empty"><span className="preview-document-icon"><Icon name="audit" size={28} /></span><h2>A final look, before you send</h2><p>Your report preview will appear here, with consumption, remaining quantities and team remarks.</p></aside>}
    </section>}
    {confirmSend && selected && <ConfirmDialog title="Send this report to Catering?" text={`${selected.flightNumber} · ${selected.serviceDate}. This will close consumption editing for your Pursers and send the report for review.`} confirm="Send report" onCancel={() => setConfirmSend(false)} onConfirm={() => { setConfirmSend(false); void sendToCatering(selected.id); }} />}
  </>;
}

function ProcurementUploads({ onCommitted }: { onCommitted: () => void }) {
  const [fileName, setFileName] = useState("");
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<ImportBatch | null>(null);
  const [history, setHistory] = useState<ImportBatch[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const loadHistory = useCallback(() => {
    api<ImportBatch[]>("/imports").then(setHistory).catch((e) => setError(e.message));
  }, []);
  useEffect(() => loadHistory(), [loadHistory]);

  function downloadTemplate() {
    const blob = new Blob([importTemplates.CATERING], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "rwandair-catering-run-template.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }
  async function chooseFile(file?: File) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv") || file.size > 1_000_000) {
      setError("Choose a CSV template file no larger than 1 MB.");
      return;
    }
    const source = await file.text();
    if (!source.trim()) return setError("The selected CSV file is empty.");
    setFileName(file.name);
    setCsv(source);
    setPreview(null);
    setError("");
  }
  async function previewFile() {
    setBusy(true);
    try {
      setPreview(await api<ImportBatch>("/imports/preview", {
        method: "POST",
        body: JSON.stringify({ type: "CATERING", fileName, csv }),
      }));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setBusy(false);
    }
  }
  async function finish(action: "commit" | "cancel") {
    if (!preview) return;
    setBusy(true);
    try {
      await api(`/imports/${preview.id}/${action}`, { method: "POST" });
      setNotice(action === "commit" ? "Import committed successfully." : "Preview cancelled without operational changes.");
      setPreview(null);
      setCsv("");
      setFileName("");
      loadHistory();
      onCommitted();
    } catch (e) {
      setError(e instanceof Error ? e.message : `Import ${action} failed`);
    } finally {
      setBusy(false);
    }
  }
  async function downloadErrors() {
    if (!preview) return;
    try {
      const result = await download(`/imports/${preview.id}/errors.csv`);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error download failed");
    }
  }
  const previewErrors = preview?.rows?.flatMap((row) => row.errors) || [];
  const itemErrors = [...new Set(previewErrors.filter((message) => message.includes("catering item")))];
  return <div className="two-col wide-left lead-import-layout">
    <section className="card import-center">
      <div className="card-head"><div><small>CATERING RUN</small><h2>Create catering run</h2></div></div>
      {error && <div className="error-box">{error}</div>}
      {notice && <div className="success-box">{notice}</div>}
      <p className="import-help">Four columns are all you need: flight number, service date, item name, and loaded quantity. Use the template to get started.</p>
      <div className="import-guide" aria-label="CSV import steps"><span><b>1</b> Download template</span><span><b>2</b> Complete required rows</span><span><b>3</b> Upload, validate and commit</span></div>
      <div className="upload-box">
        <button className="outline" onClick={downloadTemplate}>Download template</button>
        <label className="file-picker"><input aria-label="Choose completed CSV file" type="file" accept=".csv,text/csv" onChange={(event) => { const input = event.currentTarget; void chooseFile(input.files?.[0]).finally(() => { input.value = ""; }); }} /><span>Choose completed CSV</span></label>
        <button className="primary" disabled={!csv || busy} onClick={previewFile}>Preview and validate</button>
        <span className="selected-file">{fileName || "No CSV selected"}</span>
      </div>
      {preview && <div className="import-preview">
        <div className="preview-summary"><b>{preview.rowCount} rows</b><span className={preview.errorCount ? "risk-text" : "healthy"}>{preview.errorCount ? `${preview.errorCount} rows need correction` : "✓ Ready to commit"}</span></div>
        {preview.errorCount > 0 && <div className="import-error-summary" role="alert"><b>Fix the rows before committing</b>{itemErrors.length > 0 && <p>{itemErrors.join("; ")} Use an item name or SKU from the active Catering catalog.</p>}</div>}
        <div className="preview-scroll">{(preview.rows || []).map((row) => <article className={row.errors.length ? "preview-row invalid" : "preview-row"} key={row.row}><b>Row {row.row}</b><span>{["flight_number", "service_date", "item", "cabin", "loaded"].filter((key) => key in row.data).map((key) => `${key}: ${row.data[key]}`).join(" · ")}</span>{row.errors.length > 0 && <em>{row.errors.join("; ")}</em>}</article>)}</div>
        <div className="preview-actions"><button className="outline" disabled={busy} onClick={() => finish("cancel")}>Cancel preview</button>{preview.errorCount > 0 && <button className="outline" disabled={busy} onClick={downloadErrors}>Download errors</button>}<button className="primary" disabled={busy || Boolean(preview.errorCount)} onClick={() => finish("commit")}>Commit import</button></div>
      </div>}
    </section>
    <section className="card import-history"><div className="card-head"><div><small>AUDIT TRAIL</small><h2>Recent imports</h2></div></div>{history.length ? history.map((item) => <article key={item.id}><div><b>{item.fileName}</b><span>{item.type} · {item.rowCount} rows</span></div><em className={item.status.toLowerCase()}>{item.status}</em><small>{new Date(item.createdAt).toLocaleString()}</small></article>) : <div className="empty">No imports yet.</div>}</section>
  </div>;
}

function Procurement({ lang, active, onNavigate }: { lang: "EN" | "FR"; active: string; onNavigate: (destination: string) => void }) {
  const [stock, setStock] = useState<Stock[]>([]),
    [runs, setRuns] = useState<CateringRun[]>([]),
    [leads, setLeads] = useState<UserOption[]>([]),
    [waste, setWaste] = useState<WasteSummary | null>(null),
    [reconciliationSearch, setReconciliationSearch] = useState(""),
    [reportDetail, setReportDetail] = useState<ReportDetail | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [assigningListId, setAssigningListId] = useState("");
  const [loading, setLoading] = useState(true);
  const [runQuery, setRunQuery] = useState("");
  const [runStatus, setRunStatus] = useState("all");
  const statusFor = (run: CateringRun) => ["APPROVED", "REJECTED"].includes(run.report?.status || "") ? "Completed" : run.report?.status === "FORWARDED" ? "Catering review" : !run.lead ? "Needs lead" : !(run.pursers?.length || run.purser) ? "Needs Purser" : "Awaiting consumption";
  const load = useCallback(async () => {
    try {
      const [stockRows, runRows, leadRows, wasteRows] = await Promise.all([
        api<Stock[]>("/procurement/stock"),
        api<CateringRun[]>("/runs"),
        api<UserOption[]>("/procurement/leads"),
        api<WasteSummary>("/procurement/waste"),
      ]);
      setStock(stockRows);
      setRuns(runRows);
      setLeads(leadRows);
      setWaste(wasteRows);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Catering dashboard failed to load");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(timer);
  }, [load]);
  if (error) return <ErrorState message={error} retry={load} />;
  if (loading) return <WorkspaceLoading />;
  const value = stock.reduce((s, x) => s + x.available * x.priceMinor, 0),
    reorders = stock.filter((x) => x.status === "REORDER").length;
  const forwardedRuns = runs.filter((run) => run.report?.status === "FORWARDED");
  const runTotals = (run: CateringRun) => {
    const totals = (run.lines || []).reduce((sum, line) => ({ loaded: sum.loaded + line.loaded, consumed: sum.consumed + line.consumed, returned: sum.returned + Math.max(0, line.loaded - line.consumed) }), { loaded: 0, consumed: 0, returned: 0 });
    return `${run.lines?.length || 0} items · ${totals.consumed} consumed · ${totals.returned} returned`;
  };
  const visibleReconciliations = forwardedRuns.filter((run) =>
    run.flightNumber
      .toLowerCase()
      .includes(reconciliationSearch.trim().toLowerCase()),
  );
  async function assignLead(runId: string, leadId: string) {
    if (!leadId) return;
    setAssigningListId(runId);
    try {
      await api(`/runs/${runId}/lead`, {
        method: "PATCH",
        body: JSON.stringify({ leadId, version: runs.find((run) => run.id === runId)?.version }),
      });
      setNotice("Cabin Services lead assigned to the catering run.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Catering assignment failed");
    } finally {
      setAssigningListId("");
    }
  }
  async function reconcile(id: string, decision: "APPROVED" | "RETURNED", version?: number) {
    const reason = decision === "RETURNED" ? window.prompt("Reason for returning this report")?.trim() : undefined;
    if (decision === "RETURNED" && !reason) return;
    try {
      await api(`/run-reports/${id}/decision`, {
        method: "PATCH",
        body: JSON.stringify({ decision, reason, version, operationId: operationId() }),
      });
      setNotice(decision === "APPROVED" ? "Reconciliation approved and stock ledger posted." : "Report returned to the flight team.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reconciliation failed");
    }
  }
  async function downloadReportFile(runId: string, format: "csv" | "pdf") {
    try {
      const result = await download(`/runs/${runId}/report.${format}`);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Report download failed");
    }
  }
  async function openReport(runId: string) {
    try {
      setReportDetail(await api<ReportDetail>(`/runs/${runId}/report`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Report failed to load");
    }
  }
  if (active === "uploads")
    return <><PageTitle eyebrow="CATERING CONTROL" title="Import catering" text="Upload your catering list, check the preview, then assign a Cabin Services lead." /><ProcurementUploads onCommitted={load} /></>;
  if (active === "reconciliation")
    return <><PageTitle eyebrow="CONSUMPTION RECONCILIATION" title="Catering reconciliation" text="Review the consumption and automatically returned quantities before approving the stock ledger." />{notice && <div className="success-box">{notice}</div>}<section className="card"><div className="card-head reconciliation-head"><div><small>ACTION REQUIRED</small><h2>Reports awaiting approval</h2></div><label>Find run<input type="search" value={reconciliationSearch} placeholder="e.g. WB 435" onChange={(event) => setReconciliationSearch(event.target.value)} /></label><span className="badge">{forwardedRuns.length}</span></div>{visibleReconciliations.length ? visibleReconciliations.map((run) => <article className="approval" key={run.id}><div><b>{run.flightNumber} · {(run.pursers || []).map((purser) => purser.name).join(", ") || run.purser?.name || "Flight Purser"}</b><span>{run.serviceDate} · {run.name}</span><span>{runTotals(run)}</span></div><button className="outline compact" onClick={() => openReport(run.id)}>Review consumption</button><button className="outline compact" onClick={() => downloadReportFile(run.id, "csv")}>CSV</button><button className="outline compact" onClick={() => downloadReportFile(run.id, "pdf")}>PDF</button><button className="reject" onClick={() => run.report && reconcile(run.report.id, "RETURNED", run.report.version)}>Return</button><button className="approve" onClick={() => run.report && reconcile(run.report.id, "APPROVED", run.report.version)}>Approve & post ledger</button></article>) : <div className="empty">{reconciliationSearch ? "No forwarded catering run matches this search." : "No reports are waiting for reconciliation."}</div>}{reportDetail && <ReportPanel report={reportDetail} onClose={() => setReportDetail(null)} onDownload={(format) => downloadReportFile(reportDetail.flight.id, format)} />}</section></>;
  if (active === "dashboard") {
    const pendingRuns = runs.filter((run) => run.status === "READY" && !run.lead);
    const leadAssignedRuns = runs.filter((run) => run.status === "READY" && run.lead);
    const purserPendingRuns = leadAssignedRuns.filter((run) => !(run.pursers?.length || run.purser));
    return <>
      <PageTitle eyebrow="YOUR CATERING WORKSPACE" title="A good service starts here" text="Your assignments, team handoffs and reports, together in one place." action={<button className="primary" onClick={() => onNavigate("uploads")}>+ Import catering</button>} />
      {notice && <div className="success-box">{notice}</div>}
      <section className="dashboard-hero">
        <div><span className="dashboard-hero-kicker">NEXT ACTION</span><h2>{pendingRuns.length ? `${pendingRuns.length} catering run${pendingRuns.length === 1 ? "" : "s"} need a lead` : purserPendingRuns.length ? `${purserPendingRuns.length} run${purserPendingRuns.length === 1 ? "" : "s"} ready for Purser assignment` : "All catering runs are assigned"}</h2><p>{pendingRuns.length ? "Assign a Cabin Services lead. The lead will assign the Pursers needed for service." : purserPendingRuns.length ? "Cabin Services can now assign multiple Flight Pursers to each run." : "Your catering runs have an operational owner."}</p></div>
        <div className="dashboard-hero-number"><strong>{pendingRuns.length + purserPendingRuns.length}</strong><span>open actions</span></div>
      </section>
      <div className="metrics dashboard-metrics">
        <Kpi label="Needs lead" value={String(pendingRuns.length)} note="Imported runs" tone={pendingRuns.length ? "warn" : "good"} />
        <Kpi label="Purser pending" value={String(purserPendingRuns.length)} note="Lead assigned" tone={purserPendingRuns.length ? "warn" : "good"} />
        <Kpi label="Assigned runs" value={String(leadAssignedRuns.length)} note="Catering ownership" tone="good" />
        <Kpi label="Awaiting reconciliation" value={String(forwardedRuns.length)} note="Forwarded reports" tone="warn" />
      </div>
      <div className="dashboard-layout">
        <section className="card assignment-inbox">
          <div className="card-head"><div><small>INBOX · IMPORTED CATERING</small><h2>Assign Cabin Services lead</h2></div><span className="badge">{pendingRuns.length} open</span></div>
          <p className="dashboard-section-copy">Every committed upload appears here. Choose the lead who owns the run; they will assign the Pursers needed from their workspace.</p>
          {pendingRuns.length ? <div className="catering-run-list">{pendingRuns.map((run) => <article className="catering-run-card" key={run.id}><div className="catering-run-main"><div className="run-icon">✦</div><div><b>{run.flightNumber}</b><span>{run.serviceDate} · {run.name}</span><small>{run.lines?.length || 0} item lines · imported by {run.createdBy?.name || "Catering"}</small></div></div><div className="catering-run-action"><label>Cabin Services lead<select aria-label={`Cabin Services lead for ${run.name}`} disabled={assigningListId === run.id} defaultValue="" onChange={(event) => void assignLead(run.id, event.target.value)}><option value="">Assign lead…</option>{leads.map((lead) => <option key={lead.id} value={lead.id}>{lead.name}</option>)}</select></label><em>Purser assignment follows</em></div></article>)}</div> : <div className="dashboard-empty"><span>✓</span><div><b>No runs need a lead</b><p>New catering imports will appear here automatically.</p></div></div>}
        </section>
        <aside className="dashboard-side">
          <section className="card dashboard-quick"><div className="card-head"><div><small>RUN STATUS</small><h2>All catering runs</h2></div><span className="badge">{runs.length}</span></div><div className="dashboard-run-filters"><input aria-label="Search run status" placeholder="Search flight, date or lead…" value={runQuery} onChange={(event) => setRunQuery(event.target.value)} /><select aria-label="Filter runs by status" value={runStatus} onChange={(event) => setRunStatus(event.target.value)}><option value="all">All statuses</option>{["Needs lead", "Needs Purser", "Awaiting consumption", "Catering review", "Completed"].map((status) => <option key={status}>{status}</option>)}</select></div><div className="catering-run-status-list">{runs.filter((run) => (runStatus === "all" || statusFor(run) === runStatus) && `${run.flightNumber} ${run.serviceDate} ${run.lead?.name || ""}`.toLowerCase().includes(runQuery.toLowerCase())).map((run) => <article key={run.id}><div><b>{run.flightNumber}</b><span>{run.serviceDate} · {run.lead?.name || "Lead pending"}</span></div><span className="run-status ready">{statusFor(run)}</span></article>)}{!runs.length && <div className="empty">Your imported catering runs will appear here.</div>}{runs.length > 0 && !runs.some((run) => (runStatus === "all" || statusFor(run) === runStatus) && `${run.flightNumber} ${run.serviceDate} ${run.lead?.name || ""}`.toLowerCase().includes(runQuery.toLowerCase())) && <div className="empty">No runs match these filters.</div>}</div></section>
          <section className="card dashboard-quick dashboard-note"><span className="dashboard-note-mark">✓</span><div><b>One simple handoff</b><p>Assign a lead. Their Pursers record consumption, then the lead sends a report back to you.</p></div></section>
        </aside>
      </div>
    </>;
  }
  return (
    <>
      <PageTitle
        eyebrow="PROCUREMENT · APPROVED LEDGER"
        title={active === "waste" ? "Waste analysis" : "Inventory control"}
        text="Values are sourced from PostgreSQL inventory, prices and approved movements."
      />
      <div className="metrics">
        <Kpi
          label="Stock value"
          value={money(value)}
          note={stock.length + " active items"}
        />
        <Kpi
          label="Reorder alerts"
          value={String(reorders)}
          note="At or below reorder point"
          tone="risk"
        />
        <Kpi
          label="Data source"
          value="Ledger"
          note="Approved reports only"
          tone="good"
        />
        <Kpi label="Currency" value="RWF" note="Effective price history" />
      </div>
      {active === "waste" ? (
        <section className="card waste-summary">
          <div className="card-head">
            <div>
              <small>APPROVED MOVEMENTS</small>
              <h2>Waste composition</h2>
            </div>
          </div>
          <div className="waste-total"><small>APPROVED LOSS VALUE</small><b>{money(waste?.totalMinor || 0)}</b><span>Includes spoilage, discard and unexplained missing stock</span></div>
          <div className="waste-reasons">{waste?.byReason.length ? waste.byReason.map((item) => <article key={item.reason}><div><b>{item.reason.replaceAll("_", " ")}</b><span>{fmt(item.quantity)} units</span></div><strong>{money(item.amountMinor)}</strong></article>) : <div className="empty">No approved catering losses yet.</div>}</div>
        </section>
      ) : (
        <section className="card">
          <div className="card-head">
            <div>
              <small>STOCK POSITION</small>
              <h2>{words[lang].stock}</h2>
            </div>
          </div>
          <div className="stock-table">
            <div className="stock-row head">
              <span>Item</span>
              <span>On hand</span>
              <span>Reserved</span>
              <span>Available</span>
              <span>Reorder</span>
              <span>Value</span>
              <span>Status</span>
            </div>
            {stock.map((x) => (
              <div className="stock-row" key={x.id}>
                <span>
                  {x.name}
                  <small>{x.sku}</small>
                </span>
                <span>{fmt(x.onHand)}</span>
                <span>{fmt(x.reserved)}</span>
                <span>{fmt(x.available)}</span>
                <span>{fmt(x.reorderPoint)}</span>
                <span>{money(x.onHand * x.priceMinor)}</span>
                <span className={x.status.toLowerCase()}>{x.status}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function Director({ active }: { active: string }) {
  const [data, setData] = useState<{
      mtdSpendMinor: number;
      wasteRate: number;
      annualizedSavingsMinor: number;
      recoverablePct: number;
      approvedReports: number;
      categoryBreakdown: Array<{ category: string; amountMinor: number }>;
      monthlyTrend: Array<{ month: string; amountMinor: number }>;
    } | null>(null),
    [operations, setOperations] = useState<OperationalSummary | null>(null),
    [error, setError] = useState("");
  const load = useCallback(
    () => Promise.all([api<typeof data>("/dashboard/director"), api<OperationalSummary>("/dashboard/operations")])
      .then(([director, operationRows]) => { setData(director); setOperations(operationRows); })
      .catch((e) => setError(e.message)),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);
  if (error) return <ErrorState message={error} retry={load} />;
  if (!data || !operations) return <WorkspaceLoading />;
  const trendMax = Math.max(1, ...data.monthlyTrend.map((item) => item.amountMinor));
  return (
    <>
      <PageTitle
        eyebrow="EXECUTIVE · APPROVED LEDGER"
        title={
          active === "costs"
            ? "Cost analytics"
            : active === "insights"
              ? "Decision insights"
              : "Catering performance"
        }
        text="Financial metrics are calculated from approved stock movements and effective prices."
      />
      <div className="metrics">
        <Kpi
          label="Month-to-date spend"
          value={money(data.mtdSpendMinor)}
          note="Approved consumption"
        />
        <Kpi
          label="Waste rate"
          value={data.wasteRate + "%"}
          note="Spoilage and discard"
          tone="warn"
        />
        <Kpi
          label="Approved runs"
          value={fmt(data.approvedReports)}
          note="Catering runs in the ledger"
          tone="good"
        />
        <Kpi
          label="Annualized savings"
          value={money(data.annualizedSavingsMinor)}
          note={`${data.recoverablePct}% recovery scenario`}
          tone="gold"
        />
      </div>
      <div className="operational-strip" aria-label="Catering consumption">
        <span><b>{fmt(operations.forwarded)}</b> reports with Catering</span>
        <span><b>{operations.consumptionRate}%</b> consumed</span>
        <span><b>{operations.returnRate}%</b> auto-returned</span>
      </div>
      {active === "insights" ? (
        <section className="card executive-insight">
          <div className="insight-icon">✦</div>
          <div>
            <small>EXPLAINABLE EXECUTIVE INSIGHT</small>
            <h2>Consumption becomes visible when reports reach Catering</h2>
            <p>
              Consumption and automatically returned quantities are operational indicators.
              Financial cost remains limited to approved ledger activity.
            </p>
          </div>
        </section>
      ) : (
        <div className="two-col wide-left">
          <section className="card chart-card">
            <div className="card-head">
              <div>
                <small>PERFORMANCE</small>
                <h2>Approved catering cost</h2>
              </div>
            </div>
            <div className="chart">
              <div className="chart-grid" />
              <div className="bars">
                {data.monthlyTrend.map((item) => <i key={item.month} title={`${item.month}: ${money(item.amountMinor)}`} style={{ height: Math.max(3, item.amountMinor / trendMax * 100) + "%" }} />)}
              </div>
            </div>
            {!data.monthlyTrend.length && <div className="empty">Approved ledger activity will populate this chart.</div>}
          </section>
          <section className="card savings-list">
            <div className="card-head">
              <div>
                <small>CONTROL STATUS</small>
                <h2>Cost by category</h2>
              </div>
            </div>
            {data.categoryBreakdown.length ? data.categoryBreakdown.map((item, i) => (
              <article key={item.category}>
                <em>0{i + 1}</em>
                <div>
                  <b>{item.category}</b>
                  <span>Approved ledger cost</span>
                </div>
                <strong>{money(item.amountMinor)}</strong>
              </article>
            )) : <div className="empty">No approved category costs yet.</div>}
          </section>
        </div>
      )}
    </>
  );
}

function Admin({ active }: { active: string }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [operations, setOperations] = useState<OperationalSummary | null>(null);
  const [userQuery, setUserQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<"ALL" | Role>("ALL");
  const [auditQuery, setAuditQuery] = useState("");
  const [auditFilter, setAuditFilter] = useState("ALL");
  const [newUser, setNewUser] = useState({ email: "", name: "", role: "ATTENDANT" as Role, temporaryPassword: "" });
  const [events, setEvents] = useState<
    Array<{
      id: string;
      action: string;
      entityType: string;
      entityId: string;
      createdAt: string;
    }>
  >([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    Promise.all([api<AdminUser[]>("/admin/users"), api<typeof events>("/audit"), api<OperationalSummary>("/dashboard/operations")])
      .then(([userRows, auditRows, operationRows]) => {
        setUsers(userRows);
        setEvents(auditRows);
        setOperations(operationRows);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Admin data failed to load"));
  }, []);
  useEffect(() => {
    const focusAuditSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('[aria-label="Search audit activity"]')?.focus();
      }
    };
    window.addEventListener("keydown", focusAuditSearch);
    return () => window.removeEventListener("keydown", focusAuditSearch);
  }, []);
  async function resetPassword(user: AdminUser) {
    const temporaryPassword = window.prompt(`Temporary password for ${user.name}`)?.trim();
    if (!temporaryPassword) return;
    if (temporaryPassword.length < 10) {
      setError("Temporary password must contain at least 10 characters.");
      return;
    }
    try {
      await api(`/admin/users/${user.id}/reset-password`, {
        method: "POST",
        body: JSON.stringify({ temporaryPassword }),
      });
      setNotice(`Password reset for ${user.name}. They must sign in again.`);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Password reset failed");
    }
  }
  async function createUser(event: React.FormEvent) {
    event.preventDefault();
    try {
      const created = await api<AdminUser>("/admin/users", {
        method: "POST",
        body: JSON.stringify(newUser),
      });
      setUsers((current) => [...current, created].sort((left, right) => left.name.localeCompare(right.name)));
      setNewUser({ email: "", name: "", role: "ATTENDANT", temporaryPassword: "" });
      setNotice(`Created ${created.name} as ${displayRole(created.role)}.`);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "User creation failed");
    }
  }
  const visibleUsers = users.filter((user) => {
    const matchesQuery = `${user.name} ${user.email}`.toLowerCase().includes(userQuery.toLowerCase());
    return matchesQuery && (roleFilter === "ALL" || user.role === roleFilter);
  });
  const visibleEvents = events.filter((event) => {
    const matchesQuery = `${event.action} ${event.entityType} ${event.entityId}`.toLowerCase().includes(auditQuery.toLowerCase());
    return matchesQuery && (auditFilter === "ALL" || event.action.startsWith(auditFilter));
  });
  return (
    <>
      {error && <div className="error-box">{error}</div>}
      {notice && <div className="success-box">{notice}</div>}
      <PageTitle
        eyebrow={active === "audit" ? "AUDIT TRAIL" : "ADMINISTRATION"}
        title={active === "audit" ? "Security activity" : "Staff accounts"}
        text={active === "audit" ? "Review access and operational events without leaving the workspace." : "Create roles, manage access recovery, and keep staff permissions current."}
      />
      {active === "users" && <><div className="metrics admin-operations-metrics">
        <Kpi label="With Catering" value={String(operations?.forwarded || 0)} note="Reports awaiting approval" tone={operations?.forwarded ? "warn" : "good"} />
        <Kpi label="Approved runs" value={String(operations?.approved || 0)} note="Posted to the ledger" tone="good" />
        <Kpi label="Consumption" value={`${operations?.consumptionRate || 0}%`} note={`${operations?.consumed || 0} of ${operations?.loaded || 0} loaded`} />
        <Kpi label="Auto-returned" value={`${operations?.returnRate || 0}%`} note={`${operations?.returned || 0} recorded`} />
      </div><section className="card admin-directory">
        <div className="card-head admin-card-heading"><div><small>ACCESS CONTROL</small><h2>Staff accounts</h2><p>Create roles, review access, and recover accounts.</p></div><span className="badge">{users.length} total</span></div>
        <form className="admin-create" onSubmit={createUser}>
          <div className="admin-create-heading"><div><b>Add a staff member</b><span>Issue a temporary password, then ask the user to change it after sign-in.</span></div><span className="admin-create-icon">+</span></div>
          <div className="admin-form-grid">
            <label>Name<input required placeholder="e.g. Aline Mukamana" value={newUser.name} onChange={(event) => setNewUser({ ...newUser, name: event.target.value })} /></label>
            <label>Work email<input required type="email" placeholder="name@wings.rw" value={newUser.email} onChange={(event) => setNewUser({ ...newUser, email: event.target.value })} /></label>
            <label>Role<select value={newUser.role} onChange={(event) => setNewUser({ ...newUser, role: event.target.value as Role })}>{(["ATTENDANT", "LEAD", "PROCUREMENT", "DIRECTOR"] as Role[]).map((role) => <option key={role} value={role}>{displayRole(role)}</option>)}</select></label>
            <label>Temporary password<input required minLength={10} type="password" placeholder="At least 10 characters" value={newUser.temporaryPassword} onChange={(event) => setNewUser({ ...newUser, temporaryPassword: event.target.value })} /></label>
          </div>
          <div className="admin-form-footer"><span>Password is never shown again after creation.</span><button className="primary" type="submit">Create user</button></div>
        </form>
        <div className="admin-directory-toolbar"><label className="admin-search"><span>⌕</span><input aria-label="Search staff" placeholder="Search by name or email" value={userQuery} onChange={(event) => setUserQuery(event.target.value)} /></label><select aria-label="Filter by role" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value as "ALL" | Role)}><option value="ALL">All roles</option>{(["ATTENDANT", "LEAD", "PROCUREMENT", "DIRECTOR", "ADMIN"] as Role[]).map((role) => <option key={role} value={role}>{displayRole(role)}</option>)}</select></div>
        <div className="admin-user-list">
          {visibleUsers.length ? visibleUsers.map((user) => (
            <article className="admin-user-row" key={user.id}>
              <span className="admin-avatar">{user.name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</span>
              <div className="admin-user-identity"><b>{user.name}</b><span>{user.email}</span></div>
              <span className={`admin-role ${user.role.toLowerCase()}`}>{displayRole(user.role)}</span>
              <span className="admin-status"><i />{user.active ? "Active" : "Inactive"}</span>
              <span className="admin-password-date">Password changed {new Date(user.passwordChangedAt).toLocaleDateString()}</span>
              <button className="outline" disabled={!user.active} onClick={() => resetPassword(user)}>Reset password</button>
            </article>
          )) : <div className="empty admin-empty">No staff match this search.</div>}
        </div>
      </section></>}
      {active === "audit" && <section className="card audit-console">
        <div className="audit-console-header"><div><small>AUDIT TRAIL</small><h2>Security activity</h2><p>Recent access and operational events, newest first.</p></div><span className="badge">{events.length} loaded</span></div>
        <div className="audit-toolbar">
          <label className="audit-search-box"><span className="audit-search-icon">⌕</span><input aria-label="Search audit activity" placeholder="Search activity, records, or reference IDs" value={auditQuery} onChange={(event) => setAuditQuery(event.target.value)} />{auditQuery && <button type="button" aria-label="Clear audit search" onClick={() => setAuditQuery("")}>×</button>}<kbd>⌘ K</kbd></label>
          <div className="audit-filter-pills" aria-label="Filter audit activity">
            {[{ value: "ALL", label: "All" }, { value: "AUTH", label: "Authentication" }, { value: "USER", label: "Users" }, { value: "IMPORT", label: "Imports" }, { value: "REPORT", label: "Reports" }].map((filter) => <button type="button" key={filter.value} className={auditFilter === filter.value ? "active" : ""} onClick={() => setAuditFilter(filter.value)}>{filter.label}</button>)}
          </div>
        </div>
        <div className="audit-scroll" role="log" aria-label="Security activity log">
          <div className="audit-columns"><span>Activity</span><span>Record</span><span>Reference</span><span>Time</span></div>
          {visibleEvents.length ? visibleEvents.map((x) => (
            <div className="audit-row" key={x.id}>
              <span className={`audit-event-icon ${x.action.startsWith("AUTH") ? "auth" : x.action.startsWith("USER") ? "user" : "ops"}`}>{x.action.startsWith("AUTH") ? "↗" : x.action.startsWith("USER") ? "＋" : "•"}</span>
              <div className="audit-event-name"><b>{x.action.replaceAll("_", " ")}</b><span>{x.action.startsWith("AUTH") ? "Authentication" : "Operational activity"}</span></div>
              <span className="audit-entity">{x.entityType}</span>
              <code>{x.entityId.slice(0, 8)}</code>
              <time>{new Date(x.createdAt).toLocaleString()}</time>
            </div>
          )) : <div className="empty admin-empty">No activity matches this filter.</div>}
        </div>
        <div className="audit-console-footer"><span>Showing {visibleEvents.length} of {events.length} loaded events</span><span>Scroll within the activity panel to review history</span></div>
      </section>}
    </>
  );
}

export default function Home() {
  const [user, setUser] = useState<SessionUser | null>(null),
    [lang, setLang] = useState<"EN" | "FR">("EN"),
    [active, setActive] = useState(""),
    [booting, setBooting] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<string | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const trackDirty = useCallback((dirty: boolean) => setUnsaved(dirty), []);
  function navigate(destination: string) {
    if (unsaved && destination !== active) { setPendingNavigation(destination); return; }
    setActive(destination); setMobileMenu(false);
  }
  function requestLogout() {
    if (unsaved) { setPendingNavigation("logout"); return; }
    void logout();
  }
  const iconFor = (destination: string) => ({ "my-runs": "runs", history: "history", operations: "runs", dashboard: "dashboard", uploads: "uploads", reconciliation: "audit", stock: "stock", waste: "chart", executive: "chart", costs: "chart", insights: "chart", users: "users", audit: "audit" }[destination] || "runs");
  useEffect(() => {
    if (!mobileMenu) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    sidebarRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileMenu(false);
      if (event.key !== "Tab") return;
      const buttons = sidebarRef.current?.querySelectorAll<HTMLButtonElement>("button");
      if (!buttons?.length) return;
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keyboard);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", keyboard); previousFocus?.focus(); };
  }, [mobileMenu]);
  useEffect(() => {
    if ("serviceWorker" in navigator)
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    api<{ user: SessionUser; csrf: string }>("/auth/me")
      .then((x) => {
        setCsrf(x.csrf, x.user);
        setUser(x.user);
        setActive(navigation[x.user.role][0]);
      })
      .catch(() => {})
      .finally(() => setBooting(false));
  }, []);
  async function logout() {
    try {
      await api("/auth/logout", { method: "POST" });
    } finally {
      await clearOfflineSession();
      setUser(null);
      setActive("");
    }
  }
  if (booting)
    return <div className="boot">RwandAir Catering Control · {words[lang].loading}</div>;
  if (!user)
    return (
      <>
        <button
          className="floating-lang"
          onClick={() => setLang(lang === "EN" ? "FR" : "EN")}
        >
          {lang}
        </button>
        <Login
          lang={lang}
          onSuccess={(u) => {
            setUser(u);
            setActive(navigation[u.role][0]);
          }}
        />
      </>
    );
  const current = active || navigation[user.role][0];
  const roleName = displayRole(user.role);
  return (
    <main className={`app-shell${collapsed ? " sidebar-collapsed" : ""}${mobileMenu ? " mobile-menu-open" : ""}`}>
      {pendingNavigation !== null && <ConfirmDialog title="Leave your unsaved changes?" text="Your consumption changes have not been saved. Stay here to save them, or discard them before leaving." confirm="Discard and leave" onCancel={() => setPendingNavigation(null)} onConfirm={() => { const destination = pendingNavigation; setPendingNavigation(null); setUnsaved(false); if (destination === "logout") void logout(); else { setActive(destination); setMobileMenu(false); } }} />}
      {mobileMenu && <button className="navigation-backdrop" aria-label="Close navigation" onClick={() => setMobileMenu(false)} />}
      <aside ref={sidebarRef} className="sidebar" aria-label="Main navigation" role={mobileMenu ? "dialog" : undefined} aria-modal={mobileMenu || undefined}>
        <div className="brand">
          <div className="rw-logo" aria-label="RwandAir" />
          <div>
            <b>RwandAir</b>
            <small>Catering Control</small>
          </div>
        </div>
        <div className="role-label">
          {roleName} {words[lang].workspace.toUpperCase()}
        </div>
        <nav>
          {navigation[user.role].map((n) => (
            <button
              type="button"
              key={n}
              aria-label={labels[n][lang]}
              title={labels[n][lang]}
              className={current === n ? "active" : ""}
              onClick={() => navigate(n)}
              aria-current={current === n ? "page" : undefined}
            >
              <Icon name={iconFor(n)} /><span className="nav-label">{labels[n][lang]}</span>
            </button>
          ))}
        </nav>
        <div className="side-bottom">
          <div className="sidebar-footnote"><span className="workspace-dot" />Catering, in good hands.</div>
          <button onClick={requestLogout} aria-label={words[lang].signOut} title={words[lang].signOut}><Icon name="logout" /><span className="nav-label">{words[lang].signOut}</span></button>
        </div>
      </aside>
      <section className="workspace">
        <header className="topbar">
          <div className="workspace-location"><button className="sidebar-toggle" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}><Icon name="collapse" /></button><button className="mobile-menu-toggle" aria-label="Open navigation" aria-expanded={mobileMenu} onClick={() => setMobileMenu((value) => !value)}><Icon name="menu" /></button><span>Catering Control <i>/</i> <b>{labels[current]?.[lang]}</b></span></div>
          <div className="top-actions">
            <NotificationInbox role={user.role} onNavigate={navigate} />
            <button
              className="lang"
              onClick={() => setLang(lang === "EN" ? "FR" : "EN")}
            >
              {lang}
            </button>
            <div className="user">
              <span>
                {user.name
                  .split(" ")
                  .map((x) => x[0])
                  .join("")}
              </span>
              <div>
                <b>{user.name}</b>
                <small>{roleName}</small>
              </div>
            </div>
          </div>
        </header>
        <nav className="mobile-nav" aria-label={`${roleName} workspace`}>
          {navigation[user.role].map((item) => (
            <button
              type="button"
              key={item}
              className={current === item ? "active" : ""}
              aria-current={current === item ? "page" : undefined}
              onClick={() => navigate(item)}
            >
              {labels[item][lang]}
            </button>
          ))}
        </nav>
        <div className="content">
          {user.role === "ATTENDANT" ? (
            <RunAttendant key={current} active={current} onDirtyChange={trackDirty} />
          ) : user.role === "LEAD" ? (
            <RunLead />
          ) : user.role === "PROCUREMENT" ? (
            <Procurement lang={lang} active={current} onNavigate={navigate} />
          ) : user.role === "DIRECTOR" ? (
            <Director active={current} />
          ) : (
            <Admin active={current} />
          )}
        </div>
      </section>
    </main>
  );
}
