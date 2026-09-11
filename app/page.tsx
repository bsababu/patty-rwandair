"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from "react";
import { api, clearOfflineSession, operationId, Role, SessionUser, setCsrf } from "./lib/api";

type Flight = {
  id: string;
  flightNumber: string;
  flightDate: string;
  aircraft: string;
  status: string;
  sectors: Array<{
    id?: string;
    sequence?: number;
    origin: string;
    destination: string;
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
  report?: { status: string } | null;
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
type CrewStatus = {
  flight: {
    id: string;
    flightNumber: string;
    flightDate: string;
    reportStatus?: string | null;
  };
  assigned: number;
  submitted: number;
  allReported: boolean;
  crew: Array<{
    assignmentId: string;
    user: UserOption;
    duty: string;
    status: "SUBMITTED" | "PENDING";
    submittedAt?: string | null;
    notes?: string | null;
  }>;
};
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
  attendants: { EN: "Flight attendants", FR: "Personnel de cabine" },
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
const importTemplates: Record<ImportType, string> = {
  FLIGHTS:
    "flight_number,flight_date,aircraft,sector_sequence,origin,destination,departure_iso,arrival_iso,economy_pax,business_pax\nWB700,2026-09-05,A330-300,1,KGL,NBO,2026-09-05T08:00:00+02:00,2026-09-05T10:30:00+03:00,220,24\nWB700,2026-09-05,A330-300,2,NBO,KGL,2026-09-05T12:00:00+03:00,2026-09-05T12:30:00+02:00,215,22",
  CATERING:
    "flight_number,flight_date,sector_sequence,cabin,item_sku,suggested,planned,approved,loaded,override_reason\nWB435,2026-09-01,1,ECONOMY,MEAL-CHK,104,108,108,108,Passenger safety buffer approved\nWB435,2026-09-01,1,BUSINESS,WATER-500,22,26,26,26,Business cabin service buffer",
};
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
              <option value="attendant@wings.rw">Flight Attendant</option>
              <option value="lead@wings.rw">Attendant Lead</option>
              <option value="procurement@wings.rw">Procurement</option>
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
    return { label: "Approved and closed", description: "Lead approved the reconciliation. No further edits are needed.", tone: "good" };
  if (reportStatus === "FORWARDED")
    return { label: "Under financial review", description: "The report is with Procurement for final reconciliation.", tone: "review" };
  if (reportStatus === "SUBMITTED")
    return { label: "Awaiting Lead review", description: "Your report was submitted and is waiting for operational review.", tone: "review" };
  if (reportStatus === "RETURNED")
    return { label: "Correction needed", description: "The report was returned. Review the notes and update the reconciliation.", tone: "warn" };
  if (status === "COMPLETED")
    return { label: "Flight completed", description: "This flight is over and can only be viewed.", tone: "muted" };
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
        <span>{new Date(flight.flightDate).toLocaleDateString()}</span>
        <span>{new Date(flight.flightDate).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        <span>{passengers} passengers</span>
      </div>
      <p>{stage.description}</p>
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
    [error, setError] = useState("");
  const activeFlights = flights.filter(
    (flight) =>
      ["SCHEDULED", "BOARDING", "ACTIVE"].includes(flight.status) &&
      !["SUBMITTED", "FORWARDED", "APPROVED", "REJECTED"].includes(
        flight.report?.status || "",
      ),
  );
  const historyFlights = flights.filter((flight) => !activeFlights.includes(flight));
  const load = useCallback(async () => {
    try {
      const f = await api<Flight[]>("/flights");
      setFlights(f);
      const initial = f.find(
        (flight) =>
          ["SCHEDULED", "BOARDING", "ACTIVE"].includes(flight.status) &&
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
    if (!detail?.id || active === "history") return;
    if (["COMPLETED", "CANCELLED"].includes(detail.status)) return;
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
      setNotes(next.report?.status === "RETURNED" ? notes : "");
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
    try {
      for (const currentManifest of detail.manifests) {
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
      }
      setError("");
      setSync("Synced");
      return true;
    } catch (e) {
      setSync((e as Error & { queued?: boolean }).queued ? "Queued offline" : "Failed");
      setError(e instanceof Error ? e.message : "Sync failed");
      return false;
    }
  }
  async function submit() {
    if (!detail) return;
    try {
      if (!(await save())) return;
      let fresh = await api<FlightDetail>(
        "/flights/" + detail.id + "/manifest",
      );
      await api("/flights/" + detail.id + "/crew-submissions", {
        method: "POST",
        body: JSON.stringify({ operationId: operationId(), notes }),
      });
      fresh = await api<FlightDetail>(
        "/flights/" + detail.id + "/manifest",
      );
      setDetail(fresh);
      if (fresh.crewDuty !== "PURSER") {
        setSync("Crew report sent");
        setError("");
        return;
      }
      await api("/flights/" + detail.id + "/reports", {
        method: "POST",
        body: JSON.stringify({
          operationId: operationId(),
          manifestVersions: Object.fromEntries(
            fresh.manifests.map((m) => [m.id, m.version]),
          ),
          notes,
        }),
      });
      setDetail({ ...fresh, report: { status: "SUBMITTED" } });
      setSync("Awaiting approval");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Submission failed");
    }
  }
  if (error && !detail) return <ErrorState message={error} retry={load} />;
  if (active === "history" && !historyFlightId)
    return (
      <>
        <PageTitle
          eyebrow="CREW HISTORY"
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
  if (!manifest) return <div className="empty">{t.loading}</div>;
  const sector = detail.sectors.find((item) => item.id === sectorId) || detail.sectors[0];
  const flightIsClosed = ["COMPLETED", "CANCELLED"].includes(detail.status);
  const reportIsClosed = ["SUBMITTED", "FORWARDED", "APPROVED", "REJECTED"].includes(
    detail.report?.status || "",
  );
  const locked = flightIsClosed || reportIsClosed || (detail.crewDuty !== "PURSER" && Boolean(detail.crewSubmission));
  const viewingHistory = active === "history";
  const stage = flightStage(detail.status, detail.report?.status);
  const lowItems = manifest.lines.filter((line) => {
    const remaining =
      line.loaded - line.consumed - line.returned - line.spoiled - line.discarded;
    const handled = line.consumed + line.returned + line.spoiled + line.discarded;
    return handled > 0 && remaining <= Math.ceil(line.loaded * 0.2);
  });
  return (
    <>
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
        action={<div className="attendant-context"><label>Flight<select value={selectedFlightId} onChange={(event) => { setHistoryFlightId(""); void selectFlight(event.target.value); }}>{(viewingHistory ? historyFlights : activeFlights).map((flight) => <option key={flight.id} value={flight.id}>{flight.flightNumber} · {new Date(flight.flightDate).toLocaleDateString()}</option>)}</select></label>{viewingHistory && <button className="outline compact" type="button" onClick={() => { setHistoryFlightId(""); setDetail(null); }}>Back to history</button>}<span className="sync-pill">● {sync}</span></div>}
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
      <div className="crew-progress" role="status">
        <div>
          <small>YOUR DUTY</small>
          <b>{detail.crewDuty === "PURSER" ? "Purser · final reconciliation owner" : "Cabin crew · service report"}</b>
        </div>
        <div>
          <small>CREW REPORTING</small>
          <b>{detail.crewProgress?.submitted || 0}/{detail.crewProgress?.assigned || 0} reported</b>
        </div>
      </div>
      <section className="card crew-roster">
        <div className="card-head">
          <div>
            <small>FLIGHT CREW</small>
            <h2>Crew on this flight</h2>
          </div>
          <span className="badge">{detail.crew?.length || 0}</span>
        </div>
        {detail.crew?.length ? detail.crew.map((member) => (
          <article className="crew-roster-row" key={member.id}>
            <div>
              <b>{member.name}</b>
              <span>{member.duty === "PURSER" ? "Purser" : "Cabin crew"}</span>
            </div>
            <em className={member.submitted ? "healthy" : "muted"}>
              {member.submitted ? "Report submitted" : "Report pending"}
            </em>
          </article>
        )) : <div className="empty">No crew has been assigned to this flight.</div>}
      </section>
      <section className="card">
        <div className="card-head">
          <div>
            <small>RECONCILIATION</small>
            <h2>{lang === "FR" ? "Service cabine" : "Cabin service"}</h2>
          </div>
          <div className="service-tabs">
          {detail.sectors.length > 1 && <div className="tabs sector-tabs" aria-label="Flight sector">{detail.sectors.map((item) => <button key={item.id} className={sectorId === item.id ? "active" : ""} onClick={() => setSectorId(item.id)}>S{item.sequence || ""} {item.origin}–{item.destination}</button>)}</div>}
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
          {manifest.lines.map((line) => {
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
          })}
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
          <button
            className="primary"
            onClick={submit}
            disabled={locked}
          >
            {locked
              ? "✓ " + (detail.report?.status || "CREW REPORT SENT")
              : detail.crewDuty === "PURSER"
                ? t.submit + " →"
                : "Send my crew report →"}
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
  const [imports] = useState<ImportBatch[]>([]);
  const [attendants, setAttendants] = useState<UserOption[]>([]);
  const [cateringOptions, setCateringOptions] = useState<CateringOption[]>([]);
  const [crewDraft, setCrewDraft] = useState<Record<string, "PURSER" | "CABIN_CREW">>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [importType, setImportType] = useState<ImportType>("FLIGHTS");
  const [fileName, setFileName] = useState("");
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<ImportBatch | null>(null);
  const [selectedFlightId, setSelectedFlightId] = useState("");
  const [plan, setPlan] = useState<LeadLoadPlan | null>(null);
  const [crewStatus, setCrewStatus] = useState<CrewStatus | null>(null);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [crewSearch, setCrewSearch] = useState("");
  const [crewSort, setCrewSort] = useState<"status" | "name">("status");

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

  const loadCrewStatus = useCallback(async (flightId: string) => {
    if (!flightId) return setCrewStatus(null);
    try {
      setCrewStatus(await api<CrewStatus>(`/lead/flights/${flightId}/crew-status`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Crew status failed to load");
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
    if (selectedFlightId) loadCrewStatus(selectedFlightId);
  }, [loadCrewStatus, selectedFlightId, flights]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      void load();
      if (selectedFlightId) void loadCrewStatus(selectedFlightId);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [load, loadCrewStatus, selectedFlightId]);
  useEffect(() => {
    if (active === "load-planning") loadPlanning(selectedFlightId);
  }, [active, loadPlanning, selectedFlightId]);

  useEffect(() => {
    const flight = flights.find((item) => item.id === selectedFlightId);
    setCrewDraft(
      Object.fromEntries(
        (flight?.assignments || []).map((assignment) => [
          assignment.user.id,
          assignment.duty === "PURSER" ? "PURSER" : "CABIN_CREW",
        ]),
      ),
    );
  }, [flights, selectedFlightId]);

  useEffect(() => {
    if (active !== "catering" || !selectedFlightId) return;
    api<CateringOption[]>(`/lead/flights/${selectedFlightId}/catering-options`)
      .then(setCateringOptions)
      .catch((e) => setError(e instanceof Error ? e.message : "Catering lists failed to load"));
  }, [active, selectedFlightId]);

  async function decide(id: string, decision: "FORWARDED" | "RETURNED") {
    const reason =
      decision === "RETURNED"
        ? window.prompt("Reason for returning this report")?.trim()
        : undefined;
    if (decision === "RETURNED" && !reason) return;
    try {
      await api("/reports/" + id + "/decision", {
        method: "PATCH",
        body: JSON.stringify({ decision, reason, operationId: operationId() }),
      });
      setNotice(decision === "FORWARDED" ? "Report forwarded to Procurement for financial reconciliation." : "Report returned to the purser.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Decision failed");
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
        }),
      });
      setNotice("Flight attendants assigned successfully.");
      await load();
      await loadCrewStatus(selectedFlightId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Crew assignment failed");
    } finally {
      setBusy(false);
    }
  }

  async function remind(userId: string) {
    if (!selectedFlightId) return;
    try {
      const result = await api<{ attendant: string }>(
        `/lead/flights/${selectedFlightId}/crew/${userId}/remind`,
        {
          method: "POST",
          body: JSON.stringify({ operationId: operationId() }),
        },
      );
      setNotice(`Reminder sent to ${result.attendant}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reminder failed");
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

  async function chooseFile(file?: File) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("Choose a CSV file created from one of the supplied templates.");
      return;
    }
    if (file.size > 1_000_000) {
      setError("The CSV file exceeds the 1 MB pilot limit.");
      return;
    }
    const source = await file.text();
    if (!source.trim()) {
      setError("The selected CSV file is empty.");
      return;
    }
    setFileName(file.name);
    setCsv(source);
    setPreview(null);
    setNotice("");
    setError("");
  }

  async function previewImport() {
    setBusy(true);
    try {
      setPreview(
        await api<ImportBatch>("/imports/preview", {
          method: "POST",
          body: JSON.stringify({ type: importType, fileName, csv }),
        }),
      );
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import preview failed");
    } finally {
      setBusy(false);
    }
  }

  async function commitImport() {
    if (!preview || preview.errorCount) return;
    setBusy(true);
    try {
      const result = await api<Record<string, unknown>>(
        `/imports/${preview.id}/commit`,
        { method: "POST" },
      );
      setNotice(`Import committed: ${JSON.stringify(result)}`);
      setPreview(null);
      setCsv("");
      setFileName("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import commit failed");
    } finally {
      setBusy(false);
    }
  }

  async function cancelImport() {
    if (!preview) return;
    setBusy(true);
    try {
      await api(`/imports/${preview.id}/cancel`, { method: "POST" });
      setNotice("Import preview cancelled. No operational records were changed.");
      setPreview(null);
      setCsv("");
      setFileName("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import cancellation failed");
    } finally {
      setBusy(false);
    }
  }

  function downloadTemplate() {
    const blob = new Blob([importTemplates[importType]], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `rwandair-${importType.toLowerCase()}-template.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
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
      ? "Assign flight attendants"
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
    .sort((left, right) => {
      if (crewSort === "name") return left.name.localeCompare(right.name);
      const rank = (id: string) => {
        const status = crewStatus?.crew.find((item) => item.user.id === id)?.status;
        return status === "PENDING" ? 0 : status === "SUBMITTED" ? 1 : 2;
      };
      return rank(left.id) - rank(right.id) || left.name.localeCompare(right.name);
    });

  return (
    <>
      <PageTitle
        eyebrow="OPERATIONS CONTROL"
        title={title}
        text="Manage one assigned flight at a time, its crew, catering and operational report."
      />
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
        <Kpi label="Reports to review" value={String(queue.length)} note="Forward to Procurement" tone="warn" />
        <Kpi label="Crew reports" value={`${crewStatus?.submitted || 0}/${crewStatus?.assigned || 0}`} note={crewStatus?.allReported ? "All assigned crew reported" : "Completion for selected flight"} tone={crewStatus?.allReported ? "good" : "warn"} />
        <Kpi label="Open variances" value={String(queue.reduce((sum, report) => sum + report.lines.filter((line) => line.unexplained > 0).length, 0))} note="Review before approval" tone="risk" />
      </div>

      {active === "operations" && (
        <section className="card">
          <div className="card-head lead-toolbar">
            <div><small>ASSIGNED OPERATION</small><h2>{t.flights}</h2></div>
            <div className="lead-actions">
              <button className="outline" onClick={() => onNavigate("attendants")}>Assign attendants</button>
              <button className="primary" onClick={() => onNavigate("catering")}>Assign catering</button>
            </div>
          </div>
          {!flights.length ? <div className="empty">Procurement has not assigned a flight to this Lead.</div> : <div className="table lead-roster">
            {flights.map((flight) => (
              <button className={selectedFlightId === flight.id ? "tr selected" : "tr"} key={flight.id} onClick={() => setSelectedFlightId(flight.id)}>
                <span className={"dot " + flight.status.toLowerCase()} />
                <b>{flight.flightNumber}</b>
                <span>{flight.sectors.map((sector) => `${sector.origin} → ${sector.destination}`).join(", ")}</span>
                <span>{new Date(flight.flightDate).toLocaleString()}</span>
                <em>{flight.cateringList?.name || "Catering not assigned"}</em>
              </button>
            ))}
          </div>}
        </section>
      )}

      {active === "attendants" && (
        <section className="card assignment-card">
          <div className="card-head load-plan-head">
            <div><small>CREW CONTROL</small><h2>Assign attendants and one purser</h2></div>
            <label>Flight<select value={selectedFlightId} onChange={(event) => setSelectedFlightId(event.target.value)}>{flights.map((flight) => <option key={flight.id} value={flight.id}>{flight.flightNumber} · {flight.sectors[0]?.origin}–{flight.sectors.at(-1)?.destination}</option>)}</select></label>
          </div>
          <div className="crew-report-summary">
            <div><b>{crewStatus?.submitted || 0} of {crewStatus?.assigned || 0} reported</b><span>{crewStatus?.allReported ? "✓ Flight crew reporting complete" : "Final reconciliation waits for every assigned crew member."}</span></div>
            <label>Search<input type="search" value={crewSearch} placeholder="Name or email" onChange={(event) => setCrewSearch(event.target.value)} /></label>
            <label>Sort<select value={crewSort} onChange={(event) => setCrewSort(event.target.value as "status" | "name")}><option value="status">Pending first</option><option value="name">Name A–Z</option></select></label>
          </div>
          {!flights.length ? <div className="empty">No flight is assigned to this Lead.</div> : <div className="crew-list">
            {visibleAttendants.map((attendant) => {
              const duty = crewDraft[attendant.id];
              const reported = crewStatus?.crew.find((item) => item.user.id === attendant.id);
              return <article key={attendant.id}>
                <label className="crew-person">
                  <input type="checkbox" disabled={Boolean(crewStatus?.submitted)} checked={Boolean(duty)} onChange={(event) => setCrewDraft((current) => {
                    const next = { ...current };
                    if (!event.target.checked) delete next[attendant.id];
                    else next[attendant.id] = Object.keys(current).length ? "CABIN_CREW" : "PURSER";
                    return next;
                  })} />
                  <span><b>{attendant.name}</b><small>{attendant.email}</small></span>
                </label>
                <select aria-label={`Duty for ${attendant.name}`} disabled={!duty || Boolean(crewStatus?.submitted)} value={duty || "CABIN_CREW"} onChange={(event) => setCrewDraft((current) => {
                  const next = { ...current };
                  const selected = event.target.value as "PURSER" | "CABIN_CREW";
                  if (selected === "PURSER") Object.keys(next).forEach((id) => { if (next[id] === "PURSER") next[id] = "CABIN_CREW"; });
                  next[attendant.id] = selected;
                  return next;
                })}><option value="CABIN_CREW">Cabin crew</option><option value="PURSER">Purser</option></select>
                <div className="crew-report-state">
                  <b className={reported?.status === "SUBMITTED" ? "healthy" : duty ? "pending" : "muted"}>{reported?.status || (duty ? "PENDING" : "NOT ASSIGNED")}</b>
                  <small>{reported?.submittedAt ? new Date(reported.submittedAt).toLocaleString() : duty ? "Awaiting crew report" : "Add to this flight if required"}</small>
                  {reported?.notes && <span title={reported.notes}>{reported.notes}</span>}
                </div>
                {duty && reported?.status !== "SUBMITTED" ? <button className="outline compact" type="button" onClick={() => remind(attendant.id)}>Send reminder</button> : <span />}
              </article>;
            })}
            <div className="assignment-footer"><span>{crewStatus?.submitted ? "Crew is locked after reporting begins" : `${Object.keys(crewDraft).length} selected`}</span><button className="primary" disabled={busy || !selectedFlightId || Boolean(crewStatus?.submitted)} onClick={saveCrew}>Save crew assignment</button></div>
          </div>}
        </section>
      )}

      {active === "catering" && (
        <section className="card assignment-card">
          <div className="card-head load-plan-head">
            <div><small>PROCUREMENT CATERING LISTS</small><h2>Select the list matching this flight</h2></div>
            <label>Flight<select value={selectedFlightId} onChange={(event) => setSelectedFlightId(event.target.value)}>{flights.map((flight) => <option key={flight.id} value={flight.id}>{flight.flightNumber} · {new Date(flight.flightDate).toLocaleDateString()}</option>)}</select></label>
          </div>
          {flights.find((item) => item.id === selectedFlightId)?.cateringList && <div className="success-box">Assigned: {flights.find((item) => item.id === selectedFlightId)?.cateringList?.name}</div>}
          {!selectedFlightId ? <div className="empty">No flight is assigned to this Lead.</div> : !cateringOptions.length ? <div className="empty">No matching catering list. Procurement must upload one named for this flight number and date.</div> : <div className="catering-options">{cateringOptions.map((option) => <article key={option.id}><div><b>{option.name}</b><span>{option._count?.lines || 0} catering lines · prepared by {option.createdBy?.name || "Procurement"}</span></div><button className="primary" disabled={busy} onClick={() => attachCatering(option.id)}>Assign to flight</button></article>)}</div>}
        </section>
      )}

      {active === "reports" && (
        <section className="card">
          <div className="card-head"><div><small>OPERATIONAL REVIEW</small><h2>Reports awaiting Procurement</h2></div><span className="badge">{queue.length}</span></div>
          {queue.length ? queue.map((report) => (
            <article className="approval" key={report.id}>
              <div><b>{report.flight.flightNumber} · {report.purserName}</b><span>Consumed {report.lines.reduce((sum, line) => sum + line.consumed, 0)} · Returned {report.lines.reduce((sum, line) => sum + line.returned, 0)} · Waste {report.lines.reduce((sum, line) => sum + line.spoiled + line.discarded, 0)} · Unexplained {report.lines.reduce((sum, line) => sum + line.unexplained, 0)}</span></div>
              <button className="reject" onClick={() => decide(report.id, "RETURNED")}>{t.return}</button>
              <button className="approve" onClick={() => decide(report.id, "FORWARDED")}>Forward to Procurement</button>
            </article>
          )) : <div className="empty">✓ {t.empty}</div>}
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
              <span>Crew reporting has started, so loaded quantities can no longer be changed.</span>
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
  const [type, setType] = useState<"FLIGHTS" | "CATERING">("CATERING");
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
  return <div className="two-col wide-left lead-import-layout">
    <section className="card import-center">
      <div className="card-head"><div><small>PROCUREMENT OWNED</small><h2>Upload flight or catering data</h2></div></div>
      {error && <div className="error-box">{error}</div>}
      {notice && <div className="success-box">{notice}</div>}
      <div className="import-tabs">{(["CATERING", "FLIGHTS"] as const).map((value) => <button key={value} className={type === value ? "active" : ""} onClick={() => { setType(value); setPreview(null); setCsv(""); setFileName(""); }}>{value}</button>)}</div>
      <p className="import-help">{type === "CATERING" ? "The committed list is named from its flight number and service date. A Lead can select it only for that matching flight." : "Create one or more flights with ordered sectors and cabin passenger counts."}</p>
      <div className="import-guide" aria-label="CSV import steps"><span><b>1</b> Download template</span><span><b>2</b> Complete required rows</span><span><b>3</b> Upload, validate and commit</span></div>
      <div className="upload-box">
        <button className="outline" onClick={downloadTemplate}>Download template</button>
        <label className="file-picker"><input aria-label="Choose completed CSV file" type="file" accept=".csv,text/csv" onChange={(event) => { const input = event.currentTarget; void chooseFile(input.files?.[0]).finally(() => { input.value = ""; }); }} /><span>Choose completed CSV</span></label>
        <button className="primary" disabled={!csv || busy} onClick={previewFile}>Preview and validate</button>
        <span className="selected-file">{fileName || "No CSV selected"}</span>
      </div>
      {preview && <div className="import-preview">
        <div className="preview-summary"><b>{preview.rowCount} rows</b><span className={preview.errorCount ? "risk-text" : "healthy"}>{preview.errorCount ? `${preview.errorCount} rows need correction` : "✓ Ready to commit"}</span></div>
        <div className="preview-scroll">{(preview.rows || []).map((row) => <article className={row.errors.length ? "preview-row invalid" : "preview-row"} key={row.row}><b>Row {row.row}</b><span>{Object.entries(row.data).map(([key, value]) => `${key}: ${value}`).join(" · ")}</span>{row.errors.length > 0 && <em>{row.errors.join("; ")}</em>}</article>)}</div>
        <div className="preview-actions"><button className="outline" disabled={busy} onClick={() => finish("cancel")}>Cancel preview</button><button className="primary" disabled={busy || Boolean(preview.errorCount)} onClick={() => finish("commit")}>Commit import</button></div>
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
      setError(e instanceof Error ? e.message : "Procurement dashboard failed to load");
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
      setNotice("Flight Lead assignment updated.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lead assignment failed");
    }
  }
  async function reconcile(id: string, decision: "APPROVED" | "RETURNED") {
    const reason = decision === "RETURNED" ? window.prompt("Reason for returning this report")?.trim() : undefined;
    if (decision === "RETURNED" && !reason) return;
    try {
      await api(`/reports/${id}/decision`, {
        method: "PATCH",
        body: JSON.stringify({ decision, reason, operationId: operationId() }),
      });
      setNotice(decision === "APPROVED" ? "Reconciliation approved and stock ledger posted." : "Report returned to the flight team.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reconciliation failed");
    }
  }
  if (active === "uploads")
    return <><PageTitle eyebrow="PROCUREMENT CONTROL" title="Operational data uploads" text="Procurement owns flight schedules and reusable catering lists; every commit is validated and audited." /><ProcurementUploads onCommitted={load} /></>;
  if (active === "reconciliation")
    return <><PageTitle eyebrow="FINANCIAL RECONCILIATION" title="Flight catering reconciliations" text="Procurement reviews flight-number-level catering totals. Crew administration remains with the Flight Lead." />{notice && <div className="success-box">{notice}</div>}<section className="card"><div className="card-head reconciliation-head"><div><small>ACTION REQUIRED</small><h2>Forwarded flight reports</h2></div><label>Find flight<input type="search" value={reconciliationSearch} placeholder="e.g. WB 435" onChange={(event) => setReconciliationSearch(event.target.value)} /></label><span className="badge">{reconciliations.length}</span></div>{visibleReconciliations.length ? visibleReconciliations.map((report) => <article className="approval" key={report.id}><div><b>{report.flight.flightNumber}</b><span>{report.flight.sectors.map((sector) => `${sector.origin} → ${sector.destination}`).join(", ")} · {new Date(report.flight.flightDate).toLocaleDateString()}</span><span>Consumed {report.lines.reduce((sum, line) => sum + line.consumed, 0)} · Returned {report.lines.reduce((sum, line) => sum + line.returned, 0)} · Waste {report.lines.reduce((sum, line) => sum + line.spoiled + line.discarded, 0)} · Unexplained {report.lines.reduce((sum, line) => sum + line.unexplained, 0)}</span></div><button className="reject" onClick={() => reconcile(report.id, "RETURNED")}>Return</button><button className="approve" onClick={() => reconcile(report.id, "APPROVED")}>Approve & post ledger</button></article>) : <div className="empty">{reconciliationSearch ? "No forwarded flight matches this search." : "No reports are waiting for reconciliation."}</div>}</section></>;
  if (active === "dashboard")
    return <><PageTitle eyebrow="PROCUREMENT CONTROL" title="Catering operations dashboard" text="Assign Leads, monitor matching catering lists, and track approved financial exposure." />{notice && <div className="success-box">{notice}</div>}<div className="metrics"><Kpi label="Stock value" value={money(value)} note={`${stock.length} catalog items`} /><Kpi label="Scheduled flights" value={String(flights.length)} note={`${flights.filter((flight) => flight.lead).length} with Leads`} tone="good" /><Kpi label="Catering lists" value={String(lists.length)} note="Flight/date matched" /><Kpi label="Awaiting reconciliation" value={String(reconciliations.length)} note="Forwarded by Leads" tone="warn" /></div><section className="card"><div className="card-head"><div><small>FLIGHT OWNERSHIP</small><h2>Assign one Lead per flight window</h2></div></div><div className="procurement-flights">{flights.map((flight) => <article key={flight.id}><div><b>{flight.flightNumber} · {flight.sectors[0]?.origin}–{flight.sectors.at(-1)?.destination}</b><span>{new Date(flight.flightDate).toLocaleString()} · {flight.cateringList?.name || "No catering assigned"}</span></div><select aria-label={`Lead for ${flight.flightNumber}`} value={flight.lead?.id || ""} onChange={(event) => assignLead(flight.id, event.target.value)}><option value="">Unassigned</option>{leads.map((lead) => <option key={lead.id} value={lead.id}>{lead.name}</option>)}</select></article>)}</div></section></>;
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
              Recommendation remains explainable and requires Procurement or
              Lead override reasons.
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

function Admin() {
  const [users, setUsers] = useState<AdminUser[]>([]);
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
  return (
    <>
      {error && <div className="error-box">{error}</div>}
      {notice && <div className="success-box">{notice}</div>}
      <PageTitle
        eyebrow="ADMINISTRATION"
        title="Users and security audit"
        text="Manage access recovery and review the latest immutable events."
      />
      <section className="card">
        <div className="card-head"><div><small>ACCESS CONTROL</small><h2>Staff accounts</h2></div><span className="badge">{users.length}</span></div>
        {users.map((user) => (
          <article className="approval" key={user.id}>
            <div><b>{user.name}</b><span>{user.email} · {user.role} · {user.active ? "Active" : "Inactive"}</span><small>Password changed {new Date(user.passwordChangedAt).toLocaleDateString()}</small></div>
            <button className="outline" disabled={!user.active} onClick={() => resetPassword(user)}>Reset password</button>
          </article>
        ))}
      </section>
      <PageTitle eyebrow="AUDIT TRAIL" title="Security audit" text="Latest authentication and operational events." />
      <section className="card table">
        {events.map((x) => (
          <div className="tr" key={x.id}>
            <span className="dot active" />
            <b>{x.action}</b>
            <span>{x.entityType}</span>
            <span>{x.entityId.slice(0, 8)}</span>
            <em>{new Date(x.createdAt).toLocaleString()}</em>
          </div>
        ))}
      </section>
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
          {user.role} {words[lang].workspace.toUpperCase()}
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
            <span>PostgreSQL · Redis · audited</span>
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
                <small>{user.role.toLowerCase()}</small>
              </div>
            </div>
          </div>
        </header>
        <nav className="mobile-nav" aria-label={`${user.role} workspace`}>
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
            <Admin />
          )}
        </div>
      </section>
    </main>
  );
}
