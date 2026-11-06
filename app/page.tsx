"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from "react";
import { api, clearOfflineSession, download, operationId, Role, SessionUser, setCsrf, offlineDrafts, discardOfflineDraft, replay, type OfflineDraft } from "./lib/api";
import { importTemplates } from "../packages/contracts/src/import-templates";

type Flight = {
  id: string;
  flightNumber: string;
  flightDate: string;
  serviceDate: string;
  scheduleIssue?: string | null;
  aircraft: string;
  status: string;
  version?: number;
  sectors: Array<{
    id?: string;
    sequence?: number;
    origin: string;
    destination: string;
    scheduledDeparture?: string;
    scheduledArrival?: string;
    economyPax: number;
    businessPax: number;
  }>;
  report?: { id: string; status: string } | null;
  lead?: { id: string; name: string; email: string } | null;
  cateringList?: { id: string; name: string; status: string } | null;
  assignments?: Array<{
    id: string;
    duty: string;
    user: { id: string; name: string; email: string };
  }>;
};
type UserOption = { id: string; name: string; email: string };
type CateringOption = {
  id: string;
  name: string;
  flightNumber: string;
  serviceDate: string;
  status: string;
  version: number;
  _count?: { lines: number; flights?: number };
  createdBy?: { name: string };
};
type Line = {
  id: string;
  loaded: number;
  consumed: number;
  returned: number;
  spoiled: number;
  discarded: number;
  remarks?: string | null;
  item: {
    id?: string;
    sku?: string;
    nameEn: string;
    nameFr: string;
    category: string;
    unit: string;
  };
};
type Manifest = {
  id: string;
  cabin: "ECONOMY" | "BUSINESS";
  version: number;
  sector: {
    id: string;
    sequence: number;
    origin: string;
    destination: string;
  };
  lines: Line[];
};
type FlightDetail = Flight & {
  manifests: Manifest[];
  report?: { status: string; notes?: string | null } | null;
  crew?: Array<{
    id: string;
    name: string;
    duty: string;
    submitted: boolean;
  }>;
  crewDuty?: "PURSER" | "CABIN_CREW" | null;
  crewSubmission?: {
    id: string;
    notes?: string | null;
    submittedAt: string;
  } | null;
  crewProgress?: { assigned: number; submitted: number };
};
type ReportDetail = {
  legacy?: boolean;
  id: string | null;
  status: string;
  version: number;
  notes?: string;
  submittedAt?: string | null;
  approvedAt?: string | null;
  purser?: { id?: string; name: string; email?: string } | null;
  flight: { id: string; flightNumber: string; serviceDate?: string; flightDate?: string; aircraft: string; status: string; sectors: Flight["sectors"] };
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
function reportIsOverdue(flight: Flight, now: number) {
  if (!now || flight.status === "CANCELLED" || (flight.report && flight.report.status !== "DRAFT")) return false;
  const arrivals = flight.sectors.map((sector) => new Date(sector.scheduledArrival || "").valueOf()).filter(Number.isFinite);
  return arrivals.length > 0 && Math.max(...arrivals) < now;
}
function PendingReportAlerts({ flights }: { flights: Flight[] }) {
  const [now, setNow] = useState(0);
  useEffect(() => { setNow(Date.now()); const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);
  const overdue = flights.filter((flight) => reportIsOverdue(flight, now));
  return overdue.length ? <section className="service-alert" role="status"><b>Overdue leftovers reports</b><span>{overdue.map((flight) => `${flight.flightNumber} (${serviceDateLabel(flight)})`).join(", ")} · Flight Purser submission pending</span></section> : null;
}
const displayRole = (role: Role) => ({ ATTENDANT: "Flight Purser", LEAD: "Cabin Services", PROCUREMENT: "Catering", DIRECTOR: "Director", ADMIN: "Admin" })[role];

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
  return <section className="report-detail-panel" aria-label="Full leftovers report">
    <header className="report-heading">
      <div><span className="report-eyebrow">Full leftovers report</span><h2>{report.flight.flightNumber}</h2><p className="report-subtitle">Revision {report.version} · {report.id || "Draft"}</p></div>
      <div className="report-heading-actions"><span className="report-status"><span className="report-status-dot" />{statusLabel}</span>{onClose && <button className="report-icon-button" onClick={onClose} aria-label="Close report">×</button>}</div>
    </header>

    <div className="report-flight-summary">
      <div className="report-flight-identity"><span className="report-flight-icon" aria-hidden="true">✈</span><div><span className="report-field-label">Route</span><p className="report-route">{report.flight.sectors.map((sector) => `${sector.origin} → ${sector.destination}`).join(" · ") || "Route unavailable"}</p></div></div>
      {onDownload && <div className="report-export-actions"><button className="report-button secondary" onClick={() => onDownload("csv")}>Download CSV</button><button className="report-button" onClick={() => onDownload("pdf")}>Download PDF</button></div>}
    </div>

    <div className="report-metadata">
      <div className="report-purser"><span className="report-avatar">FP</span><div><span className="report-field-label">Reported by</span><p>{report.purser?.name || "Flight Purser"}</p></div></div>
      <div className="report-purser"><div><span className="report-field-label">Service date</span><p>{serviceDateLabel(report.flight)}</p></div></div>
      <div className="report-purser"><div><span className="report-field-label">Aircraft</span><p>{report.flight.aircraft || "—"}</p></div></div>
    </div>

    {report.legacy && <p className="report-section-note" role="status">Historical report: some original metadata was not retained. This view uses the records available at upgrade.</p>}

    <section className="report-section" aria-labelledby="report-overview-heading">
      <div className="report-section-heading"><h3 id="report-overview-heading">At a glance</h3><span className="report-section-note">Submitted {report.submittedAt ? new Date(report.submittedAt).toLocaleString() : "Not submitted"}</span></div>
      <div className="report-overview">
        <div className="report-overview-stat"><span className="report-stat-caption">Items recorded</span><p className="report-stat-values">{report.lines.length}</p></div>
        <div className="report-overview-stat"><span className="report-stat-caption">Loaded</span><p className="report-stat-values report-stat-values-mixed">{quantityByUnit(report.lines, "loaded")}</p></div>
        <div className="report-overview-stat"><span className="report-stat-caption">Returned</span><p className="report-stat-values report-stat-values-mixed">{quantityByUnit(report.lines, "returned")}</p></div>
        <div className="report-overview-stat"><span className="report-stat-caption">Exceptions</span><p className="report-stat-values report-stat-values-mixed">{quantityByUnit(report.lines, "spoiled")} spoiled · {quantityByUnit(report.lines, "discarded")} discarded · {quantityByUnit(report.lines, "unexplained")} unexplained</p></div>
      </div>
    </section>

    <section className="report-section" aria-labelledby="report-sectors-heading">
      <div className="report-section-heading"><h3 id="report-sectors-heading">Flight sectors</h3><span className="report-section-note">{report.flight.sectors.length} {report.flight.sectors.length === 1 ? "sector" : "sectors"}</span></div>
      <div className="report-sectors">{report.flight.sectors.map((sector, index) => <article className="report-purser" key={sector.sequence || index}>
        <div style={{ width: "100%" }}><p className="report-sector-route"><span className="report-sector-index">S{sector.sequence || index + 1}</span>{sector.origin} → {sector.destination}</p><p className="report-sector-schedule">{sector.scheduledDeparture || "Departure —"} · {sector.scheduledArrival || "Arrival —"}</p><p className="report-sector-passengers">{sector.economyPax} economy · {sector.businessPax} business passengers</p></div>
      </article>)}</div>
    </section>

    <section className="report-items-section" aria-labelledby="report-items-heading">
      <div className="report-section-heading"><h3 id="report-items-heading">Catering details</h3><span className="report-section-note">Loaded, consumed and remaining quantities</span></div>
      {[...groups.values()].map((group) => <article className="report-item-group" key={`${group.sector}-${group.cabin}`}>
        <div className="report-group-heading"><p className="report-cabin">S{group.sector} · {group.origin} → {group.destination} · {group.cabin}</p><span className="report-count">{group.lines.length} {group.lines.length === 1 ? "item" : "items"}</span></div>
        <div className="report-line-table"><table><thead><tr><th>Item / SKU</th><th>Loaded</th><th>Consumed</th><th>Returned</th><th>Spoiled</th><th>Discarded</th><th>Unexplained</th><th>Remarks</th></tr></thead><tbody>{group.lines.map((line, index) => <tr key={`${line.sku}-${index}`}><td><span className="report-item-code">{line.item}</span><span className="report-item-remark">{line.sku} · {line.unit}</span></td><td className="report-number">{line.loaded}</td><td className="report-number">{line.consumed}</td><td className="report-number">{line.returned}</td><td className="report-number">{line.spoiled}</td><td className="report-number">{line.discarded}</td><td className="report-number">{line.unexplained}</td><td>{line.remarks || "—"}</td></tr>)}</tbody></table></div>
        <div className="report-mobile-items">{group.lines.map((line, index) => <article key={`${line.sku}-mobile-${index}`}><div><span className="report-item-code">{line.item}</span><span className="report-item-remark">{line.sku} · {line.unit}{line.remarks ? ` · ${line.remarks}` : ""}</span></div><div className="report-mobile-quantities"><span>Loaded <b>{line.loaded}</b></span><span>Consumed <b>{line.consumed}</b></span><span>Returned <b>{line.returned}</b></span><span>Spoiled <b>{line.spoiled}</b></span><span>Discarded <b>{line.discarded}</b></span><span>Unexplained <b>{line.unexplained}</b></span></div></article>)}</div>
        <div className="report-mobile-totals"><span>Loaded {quantityByUnit(group.lines, "loaded")}</span><span>Consumed {quantityByUnit(group.lines, "consumed")}</span><span>Returned {quantityByUnit(group.lines, "returned")}</span></div>
      </article>)}
      {!report.lines.length && <p className="report-empty">No catering lines were recorded for this report.</p>}
    </section>

    <section className="report-section report-totals-section" aria-labelledby="report-totals-heading">
      <div className="report-section-heading"><h3 id="report-totals-heading">Totals by sector, cabin and unit</h3><span className="report-section-note">Separated for reconciliation</span></div>
      <div className="report-line-table"><table><thead><tr><th>Sector / cabin</th><th>Unit</th><th>Loaded</th><th>Consumed</th><th>Returned</th><th>Spoiled</th><th>Discarded</th><th>Unexplained</th></tr></thead><tbody>{[...unitTotals.values()].map((total) => <tr key={`${total.sector}-${total.cabin}-${total.unit}`}><td>S{total.sector} · {total.cabin}</td><td>{total.unit}</td><td className="report-number">{total.loaded}</td><td className="report-number">{total.consumed}</td><td className="report-number">{total.returned}</td><td className="report-number">{total.spoiled}</td><td className="report-number">{total.discarded}</td><td className="report-number">{total.unexplained}</td></tr>)}</tbody></table></div>
      <div className="report-mobile-items report-mobile-total-cards">{[...unitTotals.values()].map((total) => <article key={`${total.sector}-${total.cabin}-${total.unit}-mobile`}><div><span className="report-item-code">S{total.sector} · {total.cabin}</span><span className="report-item-remark">Unit: {total.unit}</span></div><div className="report-mobile-quantities"><span>Loaded <b>{total.loaded}</b></span><span>Consumed <b>{total.consumed}</b></span><span>Returned <b>{total.returned}</b></span><span>Spoiled <b>{total.spoiled}</b></span><span>Discarded <b>{total.discarded}</b></span><span>Unexplained <b>{total.unexplained}</b></span></div></article>)}</div>
    </section>

    <div className="report-notes-and-history">
      <section className="report-notes"><h4>Purser notes</h4><p>{report.notes || "No notes were added."}</p><p className="report-notes-author">Submitted by {report.purser?.name || "Flight Purser"}</p></section>
      {report.reviewHistory?.length ? <section className="report-history"><h4>Review history</h4>{report.reviewHistory.map((event, index) => <div key={`${event.createdAt}-${index}`}><span className="report-timeline-dot" /><div><span className="report-event-meta">{new Date(event.createdAt).toLocaleString()}</span><p><b>{event.decision}</b> · {event.actorName}{event.reason ? ` · ${event.reason}` : ""}</p></div></div>)}</section> : null}
    </div>

    <footer className="report-document-footer"><span className="report-legacy">{report.approvedAt ? `Approved ${new Date(report.approvedAt).toLocaleString()}` : "Awaiting approval"}</span><span className="report-legacy">Report ID {report.id || "Draft"}</span></footer>
  </section>;
}
type NotificationItem = {
  id: string;
  title: string;
  body: string;
  kind: string;
  flightId?: string | null;
  actionPath?: string | null;
  readAt?: string | null;
  createdAt: string;
};
type Approval = {
  id: string;
  status: string;
  version?: number;
  purserName: string;
  submittedAt: string;
  flight: Flight;
  lines: Array<{
    consumed: number;
    returned: number;
    spoiled: number;
    discarded: number;
    unexplained: number;
  }>;
};
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
type LoadPlanLine = Line & {
  suggested: number;
  planned: number;
  approved: number;
  overrideReason?: string | null;
};
type LoadPlanManifest = {
  id: string;
  version: number;
  cabin: "ECONOMY" | "BUSINESS";
  sector: { sequence: number; origin: string; destination: string };
  lines: LoadPlanLine[];
};
type LeadLoadPlan = {
  flight: Flight & {
    manifests: LoadPlanManifest[];
    report?: { status: string } | null;
  };
  forecasts: Array<{
    id: string;
    itemId: string;
    cabin: "ECONOMY" | "BUSINESS";
    baseline: number;
    safetyBuffer: number;
    suggested: number;
    confidence: string;
    sampleSize: number;
    explanation: string;
  }>;
  crewSubmissionCount: number;
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
    demo: "Fictional pilot data",
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
    demo: "Données pilotes fictives",
  },
} as const;
const navigation: Record<Role, string[]> = {
  ATTENDANT: ["my-flight", "history"],
  LEAD: ["operations", "attendants", "catering", "load-planning", "reports"],
  PROCUREMENT: ["dashboard", "uploads", "reconciliation", "stock", "waste"],
  DIRECTOR: ["executive", "costs", "insights"],
  ADMIN: ["users", "audit"],
};
const labels: Record<string, { EN: string; FR: string }> = {
  "my-flight": { EN: "My flight", FR: "Mon vol" },
  history: { EN: "History", FR: "Historique" },
  operations: { EN: "Operations", FR: "Opérations" },
  attendants: { EN: "Flight Purser", FR: "Chef de cabine" },
  catering: { EN: "Assign catering", FR: "Affecter le catering" },
  "load-planning": { EN: "Load planning", FR: "Plan de chargement" },
  reports: { EN: "Flight reports", FR: "Rapports de vol" },
  dashboard: { EN: "Dashboard", FR: "Tableau de bord" },
  uploads: { EN: "Upload data", FR: "Importer des données" },
  reconciliation: { EN: "Reconciliation", FR: "Rapprochement" },
  stock: { EN: "Stock", FR: "Stock" },
  waste: { EN: "Waste analysis", FR: "Analyse des pertes" },
  forecasts: { EN: "Forecasts", FR: "Prévisions" },
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
          <span>RWANDAIR FLIGHT OPERATIONS</span>
          <h1>
            Every flight.
            <br />
            Better supplied.
            <br />
            <em>Fully accounted.</em>
          </h1>
          <p>
            One operational view from galley loading to post-flight
            reconciliation, built for the teams who keep RwandAir moving.
          </p>
          <div className="story-stats">
            <div>
              <b>−18%</b>
              <small>target waste reduction</small>
            </div>
            <div>
              <b>24</b>
              <small>flights tracked today</small>
            </div>
          </div>
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
      <strong>{value}</strong>
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

function flightStage(status: string, reportStatus?: string | null) {
  if (reportStatus === "APPROVED")
    return { label: "Approved and closed", description: "Catering approved the reconciliation. No further edits are needed.", tone: "good" };
  if (reportStatus === "FORWARDED")
    return { label: "Under financial review", description: "The report is with Catering for final reconciliation.", tone: "review" };
  if (reportStatus === "SUBMITTED")
    return { label: "Awaiting Cabin Services review", description: "Your report was submitted and is waiting for operational review.", tone: "review" };
  if (reportStatus === "RETURNED")
    return { label: "Correction needed", description: "The report was returned. Review the notes and update the reconciliation.", tone: "warn" };
  if (status === "COMPLETED")
    return { label: "Flight completed", description: "The flight has ended. Complete its leftovers report.", tone: "muted" };
  if (status === "CANCELLED")
    return { label: "Flight cancelled", description: "This flight is closed and can only be viewed.", tone: "muted" };
  if (status === "BOARDING")
    return { label: "Boarding in progress", description: "Crew should finish the load check before departure.", tone: "active" };
  if (status === "SCHEDULED")
    return { label: "Scheduled", description: "Prepare the cabin service and complete the report after the flight.", tone: "scheduled" };
  return { label: "In service", description: "Record what was consumed, returned, spoiled, or discarded.", tone: "active" };
}

function FlightCard({
  flight,
  selected,
  onClick,
}: {
  flight: Flight;
  selected: boolean;
  onClick: () => void;
}) {
  const first = flight.sectors[0];
  const last = flight.sectors.at(-1) || first;
  const stage = flightStage(flight.status, flight.report?.status);
  const passengers = first
    ? first.economyPax + first.businessPax
    : 0;
  return (
    <button
      type="button"
      className={`flight-card ${selected ? "selected" : ""}`}
      onClick={onClick}
      aria-pressed={selected}
    >
      <div className="flight-card-top">
        <span>{flight.flightNumber}</span>
        <em className={`flight-stage ${stage.tone}`}>{stage.label}</em>
      </div>
      <strong>{first?.origin || "—"} <i>→</i> {last?.destination || "—"}</strong>
      <div className="flight-card-meta">
        <span>{serviceDateLabel(flight)}</span>
        <span>{new Date(flight.flightDate).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        <span>{passengers} passengers</span>
      </div>
      <p>{stage.description}</p>
      {flight.scheduleIssue && <p role="status">Schedule needs review: {flight.scheduleIssue}</p>}
      <small>{selected ? "Currently open" : "Open flight details"} <b>→</b></small>
    </button>
  );
}

function Attendant({ lang, active }: { lang: "EN" | "FR"; active: string }) {
  const t = words[lang],
    [flights, setFlights] = useState<Flight[]>([]),
    [detail, setDetail] = useState<FlightDetail | null>(null),
    [selectedFlightId, setSelectedFlightId] = useState(""),
    [historyFlightId, setHistoryFlightId] = useState(""),
    [sectorId, setSectorId] = useState(""),
    [cabin, setCabin] = useState<"ECONOMY" | "BUSINESS">("ECONOMY"),
    [notes, setNotes] = useState(""),
    [sync, setSync] = useState("Synced"),
    [now, setNow] = useState(0),
    [previewOpen, setPreviewOpen] = useState(false),
    [preparedReport, setPreparedReport] = useState<ReportDetail | null>(null),
    [preparedVersions, setPreparedVersions] = useState<Record<string, number>>({}),
    [pendingDrafts, setPendingDrafts] = useState<OfflineDraft[]>([]),
    [notifications, setNotifications] = useState<NotificationItem[]>([]),
    [error, setError] = useState("");
  const activeFlights = flights.filter(
    (flight) =>
      ["SCHEDULED", "BOARDING", "ACTIVE", "COMPLETED"].includes(flight.status) &&
      !["SUBMITTED", "FORWARDED", "APPROVED", "REJECTED"].includes(
        flight.report?.status || "",
      ),
  );
  const historyFlights = flights.filter((flight) => !activeFlights.includes(flight));
  const load = useCallback(async () => {
    try {
      const [f, notificationRows] = await Promise.all([
        api<Flight[]>("/flights"),
        api<NotificationItem[]>("/notifications"),
      ]);
      setFlights(f);
      setNotifications(notificationRows);
      const initial = f.find(
        (flight) =>
        ["SCHEDULED", "BOARDING", "ACTIVE", "COMPLETED"].includes(flight.status) &&
          !["SUBMITTED", "FORWARDED", "APPROVED", "REJECTED"].includes(
            flight.report?.status || "",
          ),
      );
      if (initial) {
        const next = await api<FlightDetail>(`/flights/${initial.id}/manifest`);
        setSelectedFlightId(initial.id);
        setDetail(next);
        setSectorId(next.sectors[0]?.id || "");
        setHistoryFlightId("");
      } else {
        setSelectedFlightId("");
        setDetail(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load flights");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    setNow(Date.now());
  }, [detail?.id, detail?.status, detail?.report?.status]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const refresh = async () => {
      const rows = await offlineDrafts();
      setPendingDrafts(rows);
      if (!rows.length && pendingDrafts.length > 0 && detail?.id && navigator.onLine) {
        const fresh = await api<FlightDetail>(`/flights/${detail.id}/manifest`);
        setDetail(fresh);
        setSync("Synced");
      }
    };
    const update = () => { void refresh().catch(() => {}); };
    update();
    window.addEventListener("rwandair-offline-change", update);
    return () => window.removeEventListener("rwandair-offline-change", update);
  }, [detail?.id, sync, pendingDrafts.length]);
  useEffect(() => {
    if (!detail?.id || active === "history") return;
    if (detail.status === "CANCELLED") return;
    if (["APPROVED", "REJECTED"].includes(detail.report?.status || "")) return;
    const timer = window.setInterval(async () => {
      try {
        const fresh = await api<FlightDetail>(`/flights/${detail.id}/manifest`);
        if (
          fresh.status !== detail.status ||
          fresh.report?.status !== detail.report?.status
        ) {
          setDetail(fresh);
          setFlights((current) =>
            current.map((flight) =>
              flight.id === fresh.id
                ? { ...flight, status: fresh.status, report: fresh.report }
                : flight,
            ),
          );
          setSync("Status updated");
        }
      } catch {
        // Keep the current draft visible when a background refresh is unavailable.
      }
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [active, detail?.id, detail?.report?.status, detail?.status]);
  async function selectFlight(id: string) {
    setSelectedFlightId(id);
    setSync("Loading…");
    try {
      const next = await api<FlightDetail>(`/flights/${id}/manifest`);
      setDetail(next);
      setSectorId(next.sectors[0]?.id || "");
      setNotes(next.report?.notes || "");
      setError("");
      setSync("Synced");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Flight failed to load");
      setSync("Failed");
    }
  }
  const manifest = detail?.manifests.find(
    (item) => item.cabin === cabin && item.sector.id === sectorId,
  );
  const flightDrafts = pendingDrafts.filter((draft) => detail?.manifests.some((entry) => draft.path === `/manifests/${entry.id}/draft`));
  async function resolveOffline(draft: OfflineDraft, reapply: boolean) {
    if (!detail) return;
    try {
      const fresh = await api<FlightDetail>(`/flights/${detail.id}/manifest`);
      const current = fresh.manifests.find((entry) => draft.path === `/manifests/${entry.id}/draft`);
      if (reapply) {
        if (!navigator.onLine || !current) throw new Error("Reconnect and reload the flight before applying the saved draft");
        const saved = JSON.parse(draft.body) as { lines: Array<Pick<Line, "id" | "consumed" | "returned" | "spoiled" | "discarded" | "remarks">> };
        await api(draft.path, { method: "PATCH", body: JSON.stringify({ operationId: operationId(), version: current.version, lines: saved.lines }) });
      }
      await discardOfflineDraft(draft.id);
      setDetail(await api<FlightDetail>(`/flights/${detail.id}/manifest`));
      setSync("Synced");
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Offline draft needs review");
    }
  }
  function change(
    id: string,
    field: "consumed" | "returned" | "spoiled" | "discarded",
    delta: number,
  ) {
    if (!detail) return;
    setDetail({
      ...detail,
      manifests: detail.manifests.map((m) => ({
        ...m,
        lines: m.lines.map((l) => {
          if (l.id !== id) return l;
          const next = Math.max(0, l[field] + delta),
            other =
              l.consumed + l.returned + l.spoiled + l.discarded - l[field];
          return other + next <= l.loaded ? { ...l, [field]: next } : l;
        }),
      })),
    });
  }
  function setQuantity(
    id: string,
    field: "consumed" | "returned" | "spoiled" | "discarded",
    rawValue: string,
  ) {
    if (!detail) return;
    const requested = rawValue === "" ? 0 : Number(rawValue);
    if (!Number.isFinite(requested)) return;
    setDetail({
      ...detail,
      manifests: detail.manifests.map((m) => ({
        ...m,
        lines: m.lines.map((line) => {
          if (line.id !== id) return line;
          const other = line.consumed + line.returned + line.spoiled + line.discarded - line[field];
          return {...line,[field]:Math.min(line.loaded-other,Math.max(0,Math.trunc(requested)))};
        }),
      })),
    });
  }
  function setRemark(id: string, remarks: string) {
    if (!detail) return;
    setDetail({
      ...detail,
      manifests: detail.manifests.map((currentManifest) => ({
        ...currentManifest,
        lines: currentManifest.lines.map((line) =>
          line.id === id ? { ...line, remarks } : line,
        ),
      })),
    });
  }
  async function save() {
    if (!detail) return false;
    setSync("Syncing…");
    let queued = false;
    try {
      for (const currentManifest of detail.manifests) {
        try {
        const result = await api<{ version: number }>(
          "/manifests/" + currentManifest.id + "/draft",
          {
          method: "PATCH",
          body: JSON.stringify({
            operationId: operationId(),
              version: currentManifest.version,
              lines: currentManifest.lines.map(
              ({ id, consumed, returned, spoiled, discarded, remarks }) => ({
                id,
                consumed,
                returned,
                spoiled,
                discarded,
                remarks,
              }),
            ),
          }),
          },
        );
        setDetail((current) =>
          current
            ? {
                ...current,
                manifests: current.manifests.map((savedManifest) =>
                  savedManifest.id === currentManifest.id
                    ? { ...savedManifest, version: result.version }
                    : savedManifest,
                ),
              }
            : current,
        );
        } catch (cause) {
          if ((cause as Error & { queued?: boolean }).queued) { queued = true; continue; }
          throw cause;
        }
      }
      if (queued) { setSync("Queued offline"); setError("Drafts for all sectors and cabins are saved offline. Reconnect to synchronize them."); return false; }
      setError("");
      setSync("Synced");
      return true;
    } catch (e) {
      setSync((e as Error & { queued?: boolean }).queued ? "Queued offline" : "Failed");
      setError(e instanceof Error ? e.message : "Sync failed");
      return false;
    }
  }
  async function prepareReport() {
    if (!detail) return;
    try {
      if ((await offlineDrafts()).some((entry) => detail.manifests.some((manifest) => entry.path === `/manifests/${manifest.id}/draft`)))
        throw new Error("Resolve or synchronize the saved offline drafts before submitting");
      if (!(await save())) return;
      const fresh = await api<FlightDetail>("/flights/" + detail.id + "/manifest");
      const report = await api<ReportDetail>(`/flights/${detail.id}/report`);
      setDetail(fresh);
      setPreparedVersions(Object.fromEntries(fresh.manifests.map((entry) => [entry.id, entry.version])));
      setPreparedReport({ ...report, notes });
      setPreviewOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to prepare report");
    }
  }
  async function openPurserNotification(item: NotificationItem) {
    try {
      if (!item.readAt) await api(`/notifications/${item.id}/read`, { method: "PATCH" });
      if (item.flightId) await selectFlight(item.flightId);
      setNotifications((current) => current.map((entry) => entry.id === item.id ? { ...entry, readAt: new Date().toISOString() } : entry));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Notification failed to open");
    }
  }
  async function submit() {
    await prepareReport();
  }
  async function confirmSubmit() {
    if (!detail || !preparedReport) return;
    try {
      const submitted = await api<{ id: string; status: string }>("/flights/" + detail.id + "/reports", {
        method: "POST",
        body: JSON.stringify({
          operationId: operationId(),
          manifestVersions: preparedVersions,
          confirmed: true,
          notes: preparedReport.notes,
        }),
      });
      setPreviewOpen(false);
      setDetail({ ...detail, report: { id: submitted.id, status: submitted.status } });
      setFlights((current) => current.map((flight) => flight.id === detail.id ? { ...flight, report: { id: submitted.id, status: submitted.status } } : flight));
      setSync("Awaiting approval");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Submission failed");
    }
  }
  async function downloadReport() {
    if (!detail) return;
    try {
      const result = await download(`/flights/${detail.id}/report.csv`);
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
  async function downloadPdfReport() {
    if (!detail) return;
    try {
      const result = await download(`/flights/${detail.id}/report.pdf`);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "PDF download failed");
    }
  }
  if (error && !detail) return <ErrorState message={error} retry={load} />;
  if (active === "history" && !historyFlightId)
    return (
      <>
        <PageTitle
          eyebrow="REPORT HISTORY"
          title={lang === "FR" ? "Historique des rapports" : "Report history"}
          text="Select a flight to review what happened and why it is read-only."
        />
        <section className="flight-card-grid history-cards">
          {historyFlights.length ? historyFlights.map((flight) => (
            <FlightCard
              key={flight.id}
              flight={flight}
              selected={false}
              onClick={() => {
                setHistoryFlightId(flight.id);
                void selectFlight(flight.id);
              }}
            />
          )) : <div className="card empty">No completed or approved flights yet.</div>}
        </section>
      </>
    );
  if (!detail)
    return (
      <>
        <PageTitle
          eyebrow="MY FLIGHTS"
          title="Ready for your next service"
          text="Choose an assigned flight to open its reconciliation workspace."
        />
        <section className="flight-card-grid" aria-label="Assigned flights">
          {activeFlights.length ? activeFlights.map((flight) => (
            <FlightCard
              key={flight.id}
              flight={flight}
              selected={false}
              onClick={() => void selectFlight(flight.id)}
            />
          )) : <div className="card empty">No active flights need your attention. Completed flights are available in History.</div>}
        </section>
      </>
    );
  const sector = detail.sectors.find((item) => item.id === sectorId) || detail.sectors[0];
  const flightIsClosed = detail.status === "CANCELLED";
  const reportIsClosed = ["SUBMITTED", "FORWARDED", "APPROVED", "REJECTED"].includes(
    detail.report?.status || "",
  );
  const locked = flightIsClosed || reportIsClosed || detail.crewDuty !== "PURSER" || previewOpen;
  const viewingHistory = active === "history";
  const stage = flightStage(detail.status, detail.report?.status);
  const overdue = reportIsOverdue(detail, now);
  const lowItems = (manifest?.lines || []).filter((line) => {
    const remaining =
      line.loaded - line.consumed - line.returned - line.spoiled - line.discarded;
    const handled = line.consumed + line.returned + line.spoiled + line.discarded;
    return handled > 0 && remaining <= Math.ceil(line.loaded * 0.2);
  });
  return (
    <>
      {previewOpen && preparedReport && <section className="card report-preview" role="dialog" aria-modal="true" aria-label="Review leftovers report">
        <h2>Review leftovers report</h2>
        {error && <div className="error-box report-submit-error" role="alert">{error}</div>}
        <ReportPanel report={preparedReport} />
        <p>Confirm that you checked the quantities for every sector and cabin.</p>
        <div className="report-footer"><button className="outline" onClick={() => { setPreviewOpen(false); setError(""); }}>Edit quantities</button><button className="primary" onClick={confirmSubmit}>Confirm and submit report →</button></div>
      </section>}
      {flightDrafts.length > 0 && <section className="card offline-drafts" role="alert"><h2>Saved offline drafts need attention</h2><p>Synchronize or resolve these drafts before submitting the report.</p>{flightDrafts.map((draft) => <article key={draft.id}><b>{detail.manifests.find((entry) => draft.path === "/manifests/" + entry.id + "/draft")?.cabin || "Cabin"} · {draft.status === "QUEUED" ? "Waiting to synchronize" : "Server changes need review"}</b><div>{draft.status === "QUEUED" ? <button className="outline" onClick={() => void replay()}>Retry sync</button> : <button className="outline" onClick={() => resolveOffline(draft, true)}>Reapply my saved values</button>}<button className="outline" onClick={() => resolveOffline(draft, false)}>Discard saved draft and reload</button></div></article>)}</section>}
      {notifications.filter((item) => !item.readAt && item.actionPath).length > 0 && <section className="lead-notifications" aria-label="Purser notifications">{notifications.filter((item) => !item.readAt && item.actionPath).map((item) => <article key={item.id}><div><b>{item.title}</b><span>{item.body}</span></div><button className="outline compact" onClick={() => void openPurserNotification(item)}>Open report</button></article>)}</section>}
      {!viewingHistory && <section className="flight-card-grid" aria-label="Assigned flights">
        {activeFlights.length ? activeFlights.map((flight) => (
          <FlightCard
            key={flight.id}
            flight={flight}
            selected={flight.id === selectedFlightId}
            onClick={() => void selectFlight(flight.id)}
          />
        )) : <div className="card empty">No active flights need your attention.</div>}
      </section>}
      <PageTitle
        eyebrow={(viewingHistory ? "HISTORY · READ ONLY · " : "ACTIVE ASSIGNMENT · ") + detail.flightNumber}
        title={sector.origin + " to " + sector.destination}
        text={locked ? "This flight is closed. The reconciliation is available for review only." : "Drafts are versioned and synchronized to the secure flight record."}
        action={<div className="attendant-context"><label>Flight<select value={selectedFlightId} onChange={(event) => { setHistoryFlightId(""); void selectFlight(event.target.value); }}>{(viewingHistory ? historyFlights : activeFlights).map((flight) => <option key={flight.id} value={flight.id}>{flight.flightNumber} · {serviceDateLabel(flight)}</option>)}</select></label>{viewingHistory && <button className="outline compact" type="button" onClick={() => { setHistoryFlightId(""); setDetail(null); }}>Back to history</button>}<span className="sync-pill">● {sync}</span></div>}
      />
      <div className="flight-hero">
        <div>
          <small>DEPARTURE</small>
          <b>
            {new Date(detail.flightDate).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </b>
          <span>{sector.origin}</span>
        </div>
        <div className="flight-path">
          <b>{detail.flightNumber}</b>
          <i>✈</i>
          <span>{detail.aircraft}</span>
        </div>
        <div>
          <small>{t.passengers.toUpperCase()}</small>
          <b>{sector.economyPax + sector.businessPax}</b>
          <span>
            {sector.economyPax} Economy · {sector.businessPax} Business
          </span>
        </div>
        <aside>
          <small>{t.status.toUpperCase()}</small>
          <b>{stage.label}</b>
          <span>{stage.description}</span>
        </aside>
      </div>
      {lowItems.length > 0 && (
        <div className="service-alert" role="status">
          <b>{lowItems.length} catering item{lowItems.length === 1 ? "" : "s"} running low</b>
          <span>Review the remaining service demand before using reserve quantities.</span>
        </div>
      )}
      {locked && <div className="service-alert read-only-alert" role="status"><b>Read-only reconciliation</b><span>{detail.report?.status === "APPROVED" ? "The Lead approved this report." : flightIsClosed ? "This flight has ended." : "Reporting has been submitted and is awaiting or past approval."}</span></div>}
      {overdue && <div className="service-alert" role="status"><b>Overdue leftovers report</b><span>The scheduled arrival has passed. Review the saved quantities and prepare the report.</span><button className="outline compact" onClick={prepareReport} disabled={locked}>Prepare report</button></div>}
      <div className="crew-progress" role="status">
        <div><small>YOUR DUTY</small><b>Flight Purser · final leftovers report</b></div>
        <div><small>REPORT STATUS</small><b>{detail.report?.status || (overdue ? "OVERDUE" : "DRAFT")}</b></div>
      </div>
      <section className="card">
        <div className="card-head">
          <div>
            <small>RECONCILIATION</small>
            <h2>{lang === "FR" ? "Service cabine" : "Cabin service"}</h2>
          </div>
          <div className="service-tabs">
          {detail.sectors.length > 1 && <div className="tabs sector-tabs" aria-label="Flight sector">{detail.sectors.map((item) => item.id && <button key={item.id} className={sectorId === item.id ? "active" : ""} onClick={() => setSectorId(item.id!)}>S{item.sequence || ""} {item.origin}–{item.destination}</button>)}</div>}
          <div className="tabs">
            <button
              className={cabin === "ECONOMY" ? "active" : ""}
              onClick={() => setCabin("ECONOMY")}
            >
              Economy
            </button>
            <button
              className={cabin === "BUSINESS" ? "active" : ""}
              onClick={() => setCabin("BUSINESS")}
            >
              Business
            </button>
          </div>
          </div>
        </div>
        {error && <div className="error-box">{error}</div>}
        <div className="manifest-list">
          {manifest ? manifest.lines.map((line) => {
            const used =
              line.consumed + line.returned + line.spoiled + line.discarded;
            const serviceRemaining = line.loaded - line.consumed - line.returned - line.spoiled - line.discarded;
            const runningLow = used > 0 && serviceRemaining <= Math.ceil(line.loaded * 0.2);
            return (
              <article className="manifest-row" key={line.id}>
                <div className="item-meta">
                  <i>{line.item.category === "Beverages" ? "◒" : "◐"}</i>
                  <div>
                    <b>{lang === "FR" ? line.item.nameFr : line.item.nameEn}</b>
                    <span>
                      {line.item.category} · {line.loaded} loaded
                    </span>
                    {runningLow && <strong className="line-warning">{serviceRemaining} remaining for service</strong>}
                  </div>
                </div>
                <div className="mini-progress">
                  <i
                    style={{
                      width:
                        (line.loaded
                          ? Math.min(100, (used / line.loaded) * 100)
                          : 0) + "%",
                    }}
                  />
                </div>
                {(
                  ["consumed", "returned", "spoiled", "discarded"] as const
                ).map((field) => (
                  <label className="counter" key={field}>
                    <span>{t[field]}</span>
                    <div>
                      <button
                        aria-label={"Decrease " + field}
                        onClick={() => change(line.id, field, -1)}
                        disabled={locked}
                      >
                        −
                      </button>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={line.loaded}
                        value={line[field]}
                        disabled={locked}
                        aria-label={t[field] + " for " + line.item.nameEn}
                        onChange={(event) => setQuantity(line.id, field, event.target.value)}
                        onFocus={(event) => event.currentTarget.select()}
                      />
                      <button
                        aria-label={"Increase " + field}
                        onClick={() => change(line.id, field, 1)}
                        disabled={locked}
                      >
                        +
                      </button>
                    </div>
                  </label>
                ))}
                <div className="variance">
                  <span>{t.variance}</span>
                  <b>{line.loaded - used}</b>
                </div>
                <label className="item-remarks">
                  <span>
                    {lang === "FR"
                      ? "Remarque (facultative*)"
                      : "Item remark (optional*)"}
                  </span>
                  <input
                    value={line.remarks || ""}
                    disabled={locked}
                    maxLength={240}
                    placeholder={
                      lang === "FR"
                        ? "*Requise si un écart ou une perte subsiste"
                        : "*Required if variance or spoilage remains"
                    }
                    onChange={(event) =>
                      setRemark(line.id, event.target.value)
                    }
                  />
                </label>
              </article>
            );
          }) : <div className="empty manifest-empty">No catering manifest is available for {sector.origin} → {sector.destination} in the {cabin.toLowerCase()} cabin. Select another sector or cabin, or ask Catering to complete the matching catering import.</div>}
        </div>
        <div className="report-footer">
          <label>
            {lang === "FR" ? "Remarques générales facultatives" : "Optional flight remarks"}
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={locked}
              placeholder={lang === "FR" ? "Ajouter des détails généraux sur le service…" : "Add any general service details…"}
            />
          </label>
          <button className="outline" onClick={save} disabled={locked}>
            {t.save}
          </button>
          {detail.report && <><button className="outline" onClick={downloadReport}>Download CSV</button><button className="outline" onClick={downloadPdfReport}>Download PDF</button></>}
          <button
            className="primary"
            onClick={submit}
            disabled={locked}
          >
            {locked
              ? "✓ " + (detail.report?.status || "REPORT READ ONLY")
              : t.submit + " →"}
          </button>
        </div>
      </section>
    </>
  );
}

function Lead({
  lang,
  active,
  onNavigate,
}: {
  lang: "EN" | "FR";
  active: string;
  onNavigate: (destination: string) => void;
}) {
  const t = words[lang];
  const [flights, setFlights] = useState<Flight[]>([]);
  const [queue, setQueue] = useState<Approval[]>([]);
  const [attendants, setAttendants] = useState<UserOption[]>([]);
  const [cateringOptions, setCateringOptions] = useState<CateringOption[]>([]);
  const [crewDraft, setCrewDraft] = useState<Record<string, "PURSER" | "CABIN_CREW">>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedFlightId, setSelectedFlightId] = useState("");
  const [plan, setPlan] = useState<LeadLoadPlan | null>(null);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [crewSearch, setCrewSearch] = useState("");
  const [reportDetail, setReportDetail] = useState<ReportDetail | null>(null);

  const load = useCallback(async () => {
    try {
      const [flightRows, approvalRows, attendantRows, notificationRows] = await Promise.all([
        api<Flight[]>("/flights"),
        api<Approval[]>("/approvals"),
        api<UserOption[]>("/lead/attendants"),
        api<NotificationItem[]>("/notifications"),
      ]);
      setFlights(flightRows);
      setQueue(approvalRows);
      setAttendants(attendantRows);
      setNotifications(notificationRows);
      setSelectedFlightId((current) => current || flightRows[0]?.id || "");
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  }, []);


  const loadPlanning = useCallback(async (flightId: string) => {
    if (!flightId) return setPlan(null);
    try {
      setPlan(await api<LeadLoadPlan>(`/lead/flights/${flightId}/load-plan`));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load plan failed");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      void load();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (active === "load-planning") loadPlanning(selectedFlightId);
  }, [active, loadPlanning, selectedFlightId]);

  useEffect(() => {
    const flight = flights.find((item) => item.id === selectedFlightId);
    setCrewDraft(
      (() => {
        const purser = flight?.assignments?.find((assignment) => assignment.duty === "PURSER");
        return purser ? { [purser.user.id]: "PURSER" as const } : {};
      })(),
    );
  }, [flights, selectedFlightId]);

  useEffect(() => {
    if (active !== "catering" || !selectedFlightId) return;
    api<CateringOption[]>(`/lead/flights/${selectedFlightId}/catering-options`)
      .then(setCateringOptions)
      .catch((e) => setError(e instanceof Error ? e.message : "Catering lists failed to load"));
  }, [active, selectedFlightId]);

  async function decide(id: string, decision: "FORWARDED" | "RETURNED", version?: number) {
    const reason =
      decision === "RETURNED"
        ? window.prompt("Reason for returning this report")?.trim()
        : undefined;
    if (decision === "RETURNED" && !reason) return;
    try {
      await api("/reports/" + id + "/decision", {
        method: "PATCH",
        body: JSON.stringify({ decision, reason, version, operationId: operationId() }),
      });
      setNotice(decision === "FORWARDED" ? "Report forwarded to Catering for financial reconciliation." : "Report returned to the purser.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Decision failed");
    }
  }

  async function openReport(flightId: string) {
    try {
      setReportDetail(await api<ReportDetail>(`/flights/${flightId}/report`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Report failed to load");
    }
  }

  async function downloadReportFile(flightId: string, format: "csv" | "pdf") {
    try {
      const result = await download(`/flights/${flightId}/report.${format}`);
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

  async function saveCrew() {
    if (!selectedFlightId) return;
    setBusy(true);
    try {
      await api(`/lead/flights/${selectedFlightId}/crew`, {
        method: "PUT",
        body: JSON.stringify({
          operationId: operationId(),
          assignments: Object.entries(crewDraft).map(([userId, duty]) => ({
            userId,
            duty,
          })),
          version: flights.find((flight) => flight.id === selectedFlightId)?.version,
        }),
      });
      setNotice("Flight Purser assigned successfully.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Crew assignment failed");
    } finally {
      setBusy(false);
    }
  }


  async function openNotification(item: NotificationItem) {
    try {
      if (!item.readAt)
        await api(`/notifications/${item.id}/read`, { method: "PATCH" });
      if (item.flightId) setSelectedFlightId(item.flightId);
      onNavigate(item.actionPath || "reports");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Notification failed to open");
    }
  }

  async function attachCatering(listId: string) {
    if (!selectedFlightId) return;
    setBusy(true);
    try {
      await api(`/lead/flights/${selectedFlightId}/catering/${listId}`, {
        method: "POST",
        body: JSON.stringify({ operationId: operationId() }),
      });
      setNotice("Matching catering list assigned to the flight.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Catering assignment failed");
    } finally {
      setBusy(false);
    }
  }

  function updatePlanLine(
    manifestId: string,
    lineId: string,
    field: "approved" | "loaded" | "overrideReason",
    value: string,
  ) {
    setPlan((current) =>
      current
        ? {
            ...current,
            flight: {
              ...current.flight,
              manifests: current.flight.manifests.map((manifest) =>
                manifest.id === manifestId
                  ? {
                      ...manifest,
                      lines: manifest.lines.map((line) =>
                        line.id === lineId
                          ? {
                              ...line,
                              [field]:
                                field === "overrideReason"
                                  ? value
                                  : Math.max(0, Math.trunc(Number(value) || 0)),
                            }
                          : line,
                      ),
                    }
                  : manifest,
              ),
            },
          }
        : current,
    );
  }

  async function saveLoadManifest(manifest: LoadPlanManifest) {
    setBusy(true);
    try {
      await api(`/lead/manifests/${manifest.id}/load`, {
        method: "PATCH",
        body: JSON.stringify({
          operationId: operationId(),
          version: manifest.version,
          lines: manifest.lines.map(({ id, approved, loaded, overrideReason }) => ({
            id,
            approved,
            loaded,
            overrideReason,
          })),
        }),
      });
      setNotice("Load manifest saved with an audit record.");
      await loadPlanning(selectedFlightId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load plan save failed");
    } finally {
      setBusy(false);
    }
  }

  if (error && !flights.length)
    return <ErrorState message={error} retry={load} />;

  const title =
    active === "attendants"
      ? "Assign Flight Purser"
      : active === "catering"
        ? "Assign catering"
        : active === "reports"
          ? "Flight reports"
          : "My assigned operation";
  const unreadNotifications = notifications.filter(
    (item) => !item.readAt && Boolean(item.actionPath),
  );
  const visibleAttendants = attendants
    .filter((attendant) =>
      `${attendant.name} ${attendant.email}`
        .toLowerCase()
        .includes(crewSearch.trim().toLowerCase()),
    )
    .sort((left, right) => left.name.localeCompare(right.name));

  return (
    <>
      <PageTitle
        eyebrow="OPERATIONS CONTROL"
        title={title}
          text="Manage one assigned flight at a time, its Flight Purser, catering and leftovers report."
      />
      <PendingReportAlerts flights={flights} />
      {unreadNotifications.length > 0 && (
        <section className="lead-notifications" aria-label="Unread notifications">
          <div>
            <small>ACTION NOTIFICATIONS</small>
            <b>{unreadNotifications.length} new update{unreadNotifications.length === 1 ? "" : "s"}</b>
          </div>
          {unreadNotifications.slice(0, 3).map((item) => (
            <button key={item.id} onClick={() => openNotification(item)}>
              <span><b>{item.title}</b><small>{item.body}</small></span>
              <em>{new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} →</em>
            </button>
          ))}
        </section>
      )}
      {error && <div className="error-box">{error}</div>}
      {notice && <div className="success-box">{notice}</div>}
      <div className="metrics">
        <Kpi label="Assigned flights" value={String(flights.length)} note="Current and historical" />
        <Kpi label="Reports to review" value={String(queue.length)} note="Forward to Catering" tone="warn" />
        <Kpi label="Purser assignment" value={Object.keys(crewDraft).length ? "1" : "0"} note="One Flight Purser per flight" tone={Object.keys(crewDraft).length ? "good" : "warn"} />
        <Kpi label="Open variances" value={String(queue.reduce((sum, report) => sum + report.lines.filter((line) => line.unexplained > 0).length, 0))} note="Review before approval" tone="risk" />
      </div>

      {active === "operations" && (
        <section className="card">
          <div className="card-head lead-toolbar">
            <div><small>ASSIGNED OPERATION</small><h2>{t.flights}</h2></div>
            <div className="lead-actions">
              <button className="outline" onClick={() => onNavigate("attendants")}>Assign Flight Purser</button>
              <button className="primary" onClick={() => onNavigate("catering")}>Assign catering</button>
            </div>
          </div>
          {!flights.length ? <div className="empty">Catering has not assigned a flight to Cabin Services.</div> : <div className="table lead-roster">
            {flights.map((flight) => (
              <button className={selectedFlightId === flight.id ? "tr selected" : "tr"} key={flight.id} onClick={() => setSelectedFlightId(flight.id)}>
                <span className={"dot " + flight.status.toLowerCase()} />
                <b>{flight.flightNumber}</b>
                <span>{flight.sectors.map((sector) => `${sector.origin} → ${sector.destination}`).join(", ")}</span>
                <span>{serviceDateLabel(flight)}</span>
                <em>{flight.cateringList?.name || "Catering not assigned"}</em>
              </button>
            ))}
          </div>}
        </section>
      )}

      {active === "attendants" && (
        <section className="card assignment-card">
          <div className="card-head load-plan-head">
            <div><small>CABIN SERVICES</small><h2>Assign one Flight Purser</h2></div>
            <label>Flight<select value={selectedFlightId} onChange={(event) => setSelectedFlightId(event.target.value)}>{flights.map((flight) => <option key={flight.id} value={flight.id}>{flight.flightNumber} · {flight.sectors[0]?.origin}–{flight.sectors.at(-1)?.destination}</option>)}</select></label>
          </div>
          <div className="crew-report-summary">
            <div><b>{Object.keys(crewDraft).length ? "Purser selected" : "No purser selected"}</b><span>The Flight Purser owns the single leftovers report. Cabin Services reviews it before Catering approval.</span></div>
            <label>Search<input type="search" value={crewSearch} placeholder="Name or email" onChange={(event) => setCrewSearch(event.target.value)} /></label>
          </div>
          {!flights.length ? <div className="empty">No flight is assigned to Cabin Services.</div> : <div className="crew-list">
            {visibleAttendants.map((attendant) => {
              const duty = crewDraft[attendant.id];
              return <article key={attendant.id}>
                <label className="crew-person">
                  <input type="radio" name="flight-purser" checked={duty === "PURSER"} onChange={() => setCrewDraft({ [attendant.id]: "PURSER" })} />
                  <span><b>{attendant.name}</b><small>{attendant.email}</small></span>
                </label>
                <span className="badge">Flight Purser</span>
                <div className="crew-report-state"><small>{duty ? "Selected Flight Purser" : "Available"}</small></div>
              </article>;
            })}
            <div className="assignment-footer"><span>{`${Object.keys(crewDraft).length ? "1 purser selected" : "Select a purser"}`}</span><button className="primary" disabled={busy || !selectedFlightId || Object.keys(crewDraft).length !== 1} onClick={saveCrew}>Save purser assignment</button></div>
          </div>}
        </section>
      )}

      {active === "catering" && (
        <section className="card assignment-card">
          <div className="card-head load-plan-head">
            <div><small>CATERING LISTS</small><h2>Select the list matching this flight</h2></div>
            <label>Flight<select value={selectedFlightId} onChange={(event) => setSelectedFlightId(event.target.value)}>{flights.map((flight) => <option key={flight.id} value={flight.id}>{flight.flightNumber} · {serviceDateLabel(flight)}</option>)}</select></label>
          </div>
          {flights.find((item) => item.id === selectedFlightId)?.cateringList && <div className="success-box">Assigned: {flights.find((item) => item.id === selectedFlightId)?.cateringList?.name}</div>}
          {!selectedFlightId ? <div className="empty">No flight is assigned to Cabin Services.</div> : !cateringOptions.length ? <div className="empty">No matching catering list. Catering must upload one named for this flight number and date.</div> : <div className="catering-options">{cateringOptions.map((option) => <article key={option.id}><div><b>{option.name}</b><span>{option._count?.lines || 0} catering lines · prepared by {option.createdBy?.name || "Catering"}</span></div><button className="primary" disabled={busy} onClick={() => attachCatering(option.id)}>Assign to flight</button></article>)}</div>}
        </section>
      )}

      {active === "reports" && (
        <section className="card">
          <div className="card-head"><div><small>OPERATIONAL REVIEW</small><h2>Reports awaiting Catering</h2></div><span className="badge">{queue.length}</span></div>
          {queue.length ? queue.map((report) => (
            <article className="approval" key={report.id}>
              <div><b>{report.flight.flightNumber} · {report.purserName}</b><span>Consumed {report.lines.reduce((sum, line) => sum + line.consumed, 0)} · Returned {report.lines.reduce((sum, line) => sum + line.returned, 0)} · Waste {report.lines.reduce((sum, line) => sum + line.spoiled + line.discarded, 0)} · Unexplained {report.lines.reduce((sum, line) => sum + line.unexplained, 0)}</span></div>
              <button className="outline compact" onClick={() => openReport(report.flight.id)}>Review details</button>
              <button className="reject" onClick={() => decide(report.id, "RETURNED", report.version)}>{t.return}</button>
              <button className="approve" onClick={() => decide(report.id, "FORWARDED", report.version)}>Forward to Catering</button>
            </article>
          )) : <div className="empty">✓ {t.empty}</div>}
          {reportDetail && <ReportPanel report={reportDetail} onClose={() => setReportDetail(null)} onDownload={(format) => downloadReportFile(reportDetail.flight.id, format)} />}
        </section>
      )}

      {active === "load-planning" && (
        <section className="card lead-load-planning">
          <div className="card-head load-plan-head">
            <div><small>EXPLAINABLE RECOMMENDATIONS</small><h2>Flight catering manifests</h2></div>
            <label>Flight<select value={selectedFlightId} onChange={(event) => setSelectedFlightId(event.target.value)}>{flights.map((flight) => <option key={flight.id} value={flight.id}>{flight.flightNumber} · {flight.sectors[0]?.origin}–{flight.sectors.at(-1)?.destination}</option>)}</select></label>
          </div>
          {plan && plan.crewSubmissionCount > 0 && (
            <div className="service-alert" role="status">
              <b>Catering load locked</b>
              <span>The leftovers report has started, so loaded quantities can no longer be changed.</span>
            </div>
          )}
          {!plan ? <div className="empty">Select a flight to load its manifests.</div> : !plan.flight.manifests.length ? <div className="empty">No catering manifest yet. Import catering data first.</div> : plan.flight.manifests.map((manifest) => (
            <article className="load-manifest" key={manifest.id}>
              <div className="manifest-heading"><div><b>{manifest.sector.origin} → {manifest.sector.destination}</b><span>Sector {manifest.sector.sequence} · {manifest.cabin}</span></div><button className="primary" disabled={busy || plan.crewSubmissionCount > 0 || ["SUBMITTED", "FORWARDED", "APPROVED", "REJECTED"].includes(plan.flight.report?.status || "")} onClick={() => saveLoadManifest(manifest)}>Save manifest</button></div>
              <div className="load-grid head"><span>Item</span><span>Suggested</span><span>Approved</span><span>Loaded</span><span>Override reason</span></div>
              {manifest.lines.map((line) => {
                const forecast = plan.forecasts.find((item) => item.itemId === line.item.id && item.cabin === manifest.cabin);
                return <div className="load-grid" key={line.id}>
                  <span><b>{line.item.nameEn}</b><small>{line.item.sku || line.item.unit}{forecast ? ` · ${forecast.confidence} confidence, ${forecast.sampleSize} flights` : " · Imported baseline"}</small></span>
                  <span><b>{line.suggested}</b>{forecast && <small>Base {forecast.baseline} + {forecast.safetyBuffer}</small>}</span>
                  <input aria-label={`Approved ${line.item.nameEn}`} type="number" min="0" value={line.approved} onChange={(event) => updatePlanLine(manifest.id, line.id, "approved", event.target.value)} />
                  <input aria-label={`Loaded ${line.item.nameEn}`} type="number" min="0" max={line.approved} value={line.loaded} onChange={(event) => updatePlanLine(manifest.id, line.id, "loaded", event.target.value)} />
                  <input aria-label={`Override reason ${line.item.nameEn}`} value={line.overrideReason || ""} placeholder={line.approved === line.suggested ? "Optional" : "Required for override"} onChange={(event) => updatePlanLine(manifest.id, line.id, "overrideReason", event.target.value)} />
                </div>;
              })}
            </article>
          ))}
        </section>
      )}
    </>
  );
}

function ProcurementUploads({ onCommitted }: { onCommitted: () => void }) {
  const [type, setType] = useState<"FLIGHTS" | "CATERING">("FLIGHTS");
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
    const blob = new Blob([importTemplates[type]], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `rwandair-${type.toLowerCase()}-template.csv`;
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
        body: JSON.stringify({ type, fileName, csv }),
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
  const missingDependencies = [...new Set(previewErrors.map((message) => message.match(/^Missing flight dependency: import (.+) for (\d{4}-\d{2}-\d{2}) first$/)).filter(Boolean).map((match) => `${match![1]} · ${match![2]}`))];
  const dateMismatches = [...new Set(previewErrors.filter((message) => message.startsWith("departure_iso calendar date")))];
  return <div className="two-col wide-left lead-import-layout">
    <section className="card import-center">
      <div className="card-head"><div><small>CATERING OWNED</small><h2>Upload flight or catering data</h2></div></div>
      {error && <div className="error-box">{error}</div>}
      {notice && <div className="success-box">{notice}</div>}
      <div className="import-tabs">{(["CATERING", "FLIGHTS"] as const).map((value) => <button key={value} className={type === value ? "active" : ""} onClick={() => { setType(value); setPreview(null); setCsv(""); setFileName(""); }}>{value}</button>)}</div>
      <p className="import-help">{type === "CATERING" ? "Import Flights first. Each catering row must match an existing flight number, service date and sector." : "Create one or more flights with ordered sectors and cabin passenger counts. The first departure date must match flight_date."}</p>
      <div className="import-guide" aria-label="CSV import steps"><span><b>1</b> Download template</span><span><b>2</b> Complete required rows</span><span><b>3</b> Upload, validate and commit</span></div>
      <div className="upload-box">
        <button className="outline" onClick={downloadTemplate}>Download template</button>
        <label className="file-picker"><input aria-label="Choose completed CSV file" type="file" accept=".csv,text/csv" onChange={(event) => { const input = event.currentTarget; void chooseFile(input.files?.[0]).finally(() => { input.value = ""; }); }} /><span>Choose completed CSV</span></label>
        <button className="primary" disabled={!csv || busy} onClick={previewFile}>Preview and validate</button>
        <span className="selected-file">{fileName || "No CSV selected"}</span>
      </div>
      {preview && <div className="import-preview">
        <div className="preview-summary"><b>{preview.rowCount} rows</b><span className={preview.errorCount ? "risk-text" : "healthy"}>{preview.errorCount ? `${preview.errorCount} rows need correction` : "✓ Ready to commit"}</span></div>
        {preview.errorCount > 0 && <div className="import-error-summary" role="alert"><b>Fix the dependencies before committing</b>{missingDependencies.length > 0 && <p>Missing flights: {missingDependencies.join(", ")}</p>}{dateMismatches.length > 0 && <p>Date mismatch: {dateMismatches.join("; ")}</p>}</div>}
        <div className="preview-scroll">{(preview.rows || []).map((row) => <article className={row.errors.length ? "preview-row invalid" : "preview-row"} key={row.row}><b>Row {row.row}</b><span>{Object.entries(row.data).map(([key, value]) => `${key}: ${value}`).join(" · ")}</span>{row.errors.length > 0 && <em>{row.errors.join("; ")}</em>}</article>)}</div>
        <div className="preview-actions"><button className="outline" disabled={busy} onClick={() => finish("cancel")}>Cancel preview</button>{preview.errorCount > 0 && <button className="outline" disabled={busy} onClick={downloadErrors}>Download errors</button>}<button className="primary" disabled={busy || Boolean(preview.errorCount)} onClick={() => finish("commit")}>Commit import</button></div>
      </div>}
    </section>
    <section className="card import-history"><div className="card-head"><div><small>AUDIT TRAIL</small><h2>Recent imports</h2></div></div>{history.length ? history.map((item) => <article key={item.id}><div><b>{item.fileName}</b><span>{item.type} · {item.rowCount} rows</span></div><em className={item.status.toLowerCase()}>{item.status}</em><small>{new Date(item.createdAt).toLocaleString()}</small></article>) : <div className="empty">No imports yet.</div>}</section>
  </div>;
}

function Procurement({ lang, active }: { lang: "EN" | "FR"; active: string }) {
  const [stock, setStock] = useState<Stock[]>([]),
    [flights, setFlights] = useState<Flight[]>([]),
    [leads, setLeads] = useState<UserOption[]>([]),
    [lists, setLists] = useState<CateringOption[]>([]),
    [reconciliations, setReconciliations] = useState<Approval[]>([]),
    [waste, setWaste] = useState<WasteSummary | null>(null),
    [reconciliationSearch, setReconciliationSearch] = useState(""),
    [reportDetail, setReportDetail] = useState<ReportDetail | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    try {
      const [stockRows, flightRows, leadRows, listRows, reportRows, wasteRows] = await Promise.all([
        api<Stock[]>("/procurement/stock"),
        api<Flight[]>("/flights"),
        api<UserOption[]>("/procurement/leads"),
        api<CateringOption[]>("/procurement/catering-lists"),
        api<Approval[]>("/procurement/reconciliations"),
        api<WasteSummary>("/procurement/waste"),
      ]);
      setStock(stockRows);
      setFlights(flightRows);
      setLeads(leadRows);
      setLists(listRows);
      setReconciliations(reportRows);
      setWaste(wasteRows);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Catering dashboard failed to load");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(timer);
  }, [load]);
  if (error) return <ErrorState message={error} retry={load} />;
  const value = stock.reduce((s, x) => s + x.available * x.priceMinor, 0),
    reorders = stock.filter((x) => x.status === "REORDER").length;
  const visibleReconciliations = reconciliations.filter((report) =>
    report.flight.flightNumber
      .toLowerCase()
      .includes(reconciliationSearch.trim().toLowerCase()),
  );
  async function assignLead(flightId: string, leadId: string) {
    try {
      await api(`/procurement/flights/${flightId}/lead`, {
        method: "PATCH",
        body: JSON.stringify({ leadId: leadId || null }),
      });
      setNotice("Cabin Services assignment updated.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cabin Services assignment failed");
    }
  }
  async function reconcile(id: string, decision: "APPROVED" | "RETURNED", version?: number) {
    const reason = decision === "RETURNED" ? window.prompt("Reason for returning this report")?.trim() : undefined;
    if (decision === "RETURNED" && !reason) return;
    try {
      await api(`/reports/${id}/decision`, {
        method: "PATCH",
        body: JSON.stringify({ decision, reason, version, operationId: operationId() }),
      });
      setNotice(decision === "APPROVED" ? "Reconciliation approved and stock ledger posted." : "Report returned to the flight team.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reconciliation failed");
    }
  }
  async function downloadReportFile(flightId: string, format: "csv" | "pdf") {
    try {
      const result = await download(`/flights/${flightId}/report.${format}`);
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
  async function openReport(flightId: string) {
    try {
      setReportDetail(await api<ReportDetail>(`/flights/${flightId}/report`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Report failed to load");
    }
  }
  if (active === "uploads")
    return <><PageTitle eyebrow="CATERING CONTROL" title="Operational data uploads" text="Catering owns flight schedules and reusable catering lists; every commit is validated and audited." /><ProcurementUploads onCommitted={load} /></>;
  if (active === "reconciliation")
    return <><PageTitle eyebrow="FINANCIAL RECONCILIATION" title="Flight catering reconciliations" text="Catering reviews flight-number-level leftovers reports. Cabin Services has already reviewed them." />{notice && <div className="success-box">{notice}</div>}<section className="card"><div className="card-head reconciliation-head"><div><small>ACTION REQUIRED</small><h2>Forwarded flight reports</h2></div><label>Find flight<input type="search" value={reconciliationSearch} placeholder="e.g. WB 435" onChange={(event) => setReconciliationSearch(event.target.value)} /></label><span className="badge">{reconciliations.length}</span></div>{visibleReconciliations.length ? visibleReconciliations.map((report) => <article className="approval" key={report.id}><div><b>{report.flight.flightNumber}</b><span>{report.flight.sectors.map((sector) => `${sector.origin} → ${sector.destination}`).join(", ")} · {serviceDateLabel(report.flight)}</span><span>Consumed {report.lines.reduce((sum, line) => sum + line.consumed, 0)} · Returned {report.lines.reduce((sum, line) => sum + line.returned, 0)} · Waste {report.lines.reduce((sum, line) => sum + line.spoiled + line.discarded, 0)} · Unexplained {report.lines.reduce((sum, line) => sum + line.unexplained, 0)}</span></div><button className="outline compact" onClick={() => openReport(report.flight.id)}>Review details</button><button className="outline compact" onClick={() => downloadReportFile(report.flight.id, "csv")}>CSV</button><button className="outline compact" onClick={() => downloadReportFile(report.flight.id, "pdf")}>PDF</button><button className="reject" onClick={() => reconcile(report.id, "RETURNED", report.version)}>Return</button><button className="approve" onClick={() => reconcile(report.id, "APPROVED", report.version)}>Approve & post ledger</button></article>) : <div className="empty">{reconciliationSearch ? "No forwarded flight matches this search." : "No reports are waiting for reconciliation."}</div>}{reportDetail && <ReportPanel report={reportDetail} onClose={() => setReportDetail(null)} onDownload={(format) => downloadReportFile(reportDetail.flight.id, format)} />}</section></>;
  if (active === "dashboard")
    return <><PageTitle eyebrow="CATERING CONTROL" title="Catering operations dashboard" text="Assign Cabin Services leads, monitor matching catering lists, and track approved financial exposure." /><PendingReportAlerts flights={flights} />{notice && <div className="success-box">{notice}</div>}<div className="metrics"><Kpi label="Stock value" value={money(value)} note={`${stock.length} catalog items`} /><Kpi label="Scheduled flights" value={String(flights.length)} note={`${flights.filter((flight) => flight.lead).length} with Cabin Services leads`} tone="good" /><Kpi label="Catering lists" value={String(lists.length)} note="Flight/date matched" /><Kpi label="Awaiting reconciliation" value={String(reconciliations.length)} note="Forwarded by Cabin Services" tone="warn" /></div><section className="card"><div className="card-head"><div><small>FLIGHT OWNERSHIP</small><h2>Assign Cabin Services per flight window</h2></div></div><div className="procurement-flights">{flights.map((flight) => <article key={flight.id}><div><b>{flight.flightNumber} · {flight.sectors[0]?.origin}–{flight.sectors.at(-1)?.destination}</b><span>{serviceDateLabel(flight)} · {flight.cateringList?.name || "No catering assigned"}</span></div><select aria-label={`Cabin Services for ${flight.flightNumber}`} value={flight.lead?.id || ""} onChange={(event) => assignLead(flight.id, event.target.value)}><option value="">Unassigned</option>{leads.map((lead) => <option key={lead.id} value={lead.id}>{lead.name}</option>)}</select></article>)}</div></section></>;
  return (
    <>
      <PageTitle
        eyebrow="PROCUREMENT · APPROVED LEDGER"
        title={
          active === "forecasts"
            ? "Forecast recommendations"
            : active === "waste"
              ? "Waste analysis"
              : "Inventory control"
        }
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
      {active === "forecasts" ? (
        <section className="card opportunity">
          <div className="insight-icon">✦</div>
          <div>
            <small>ROUTE RECENT AVERAGE</small>
            <h2>Reduce water safety load after sufficient history</h2>
            <p>
              Recommendation remains explainable and requires Catering or
              Cabin Services override reasons.
            </p>
          </div>
          <div className="confidence">
            <span>Confidence</span>
            <b>High</b>
            <small>18-flight sample</small>
          </div>
        </section>
      ) : active === "waste" ? (
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

function Director({ lang, active }: { lang: "EN" | "FR"; active: string }) {
  const [data, setData] = useState<{
      mtdSpendMinor: number;
      wasteRate: number;
      costPerPaxMinor: number;
      annualizedSavingsMinor: number;
      recoverablePct: number;
      passengers: number;
      approvedReports: number;
      flights: number;
      categoryBreakdown: Array<{ category: string; amountMinor: number }>;
      monthlyTrend: Array<{ month: string; amountMinor: number }>;
    } | null>(null),
    [error, setError] = useState("");
  const load = useCallback(
    () =>
      api<typeof data>("/dashboard/director")
        .then(setData)
        .catch((e) => setError(e.message)),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);
  if (error) return <ErrorState message={error} retry={load} />;
  if (!data) return <div className="empty">{words[lang].loading}</div>;
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
          label="Cost per passenger"
          value={money(data.costPerPaxMinor)}
          note={`${fmt(data.passengers)} passengers on approved reports`}
          tone="good"
        />
        <Kpi
          label="Annualized savings"
          value={money(data.annualizedSavingsMinor)}
          note={`${data.recoverablePct}% recovery scenario`}
          tone="gold"
        />
      </div>
      <div className="operational-strip" aria-label="Operational coverage">
        <span><b>{fmt(data.flights)}</b> total flights</span>
        <span><b>{fmt(data.approvedReports)}</b> approved reports</span>
        <span><b>{fmt(data.passengers)}</b> reconciled passengers</span>
      </div>
      {active === "insights" ? (
        <section className="card executive-insight">
          <div className="insight-icon">✦</div>
          <div>
            <small>EXPLAINABLE EXECUTIVE INSIGHT</small>
            <h2>Insights activate as reports are approved</h2>
            <p>
              The engine uses route, cabin, category and item movement patterns.
              It does not send operational data to an external AI service.
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
    Promise.all([api<AdminUser[]>("/admin/users"), api<typeof events>("/audit")])
      .then(([userRows, auditRows]) => {
        setUsers(userRows);
        setEvents(auditRows);
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
      {active === "users" && <section className="card admin-directory">
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
      </section>}
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
    <main className="app-shell">
      <aside className="sidebar">
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
          {navigation[user.role].map((n, i) => (
            <button
              type="button"
              key={n}
              aria-label={labels[n][lang]}
              title={labels[n][lang]}
              className={current === n ? "active" : ""}
              onClick={() => setActive(n)}
              aria-current={current === n ? "page" : undefined}
            >
              <i>{["⌂", "✈", "□", "⌁"][i] || "·"}</i>
              {labels[n][lang]}
            </button>
          ))}
        </nav>
        <div className="side-bottom">
          <div className="savings">
            <small>SECURE PILOT</small>
            <strong>{words[lang].demo}</strong>
            <span>PostgreSQL · audited</span>
          </div>
          <button onClick={logout}>⇥ {words[lang].signOut}</button>
        </div>
      </aside>
      <section className="workspace">
        <header className="topbar">
          <div className="mobile-brand">WB</div>
          <div className="flight-search">● Secure pilot environment</div>
          <div className="top-actions">
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
              onClick={() => setActive(item)}
            >
              {labels[item][lang]}
            </button>
          ))}
        </nav>
        <div className="content">
          {user.role === "ATTENDANT" ? (
            <Attendant lang={lang} active={current} />
          ) : user.role === "LEAD" ? (
            <Lead lang={lang} active={current} onNavigate={setActive} />
          ) : user.role === "PROCUREMENT" ? (
            <Procurement lang={lang} active={current} />
          ) : user.role === "DIRECTOR" ? (
            <Director lang={lang} active={current} />
          ) : (
            <Admin active={current} />
          )}
        </div>
      </section>
    </main>
  );
}
