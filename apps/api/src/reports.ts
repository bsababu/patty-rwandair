import PDFDocument from "pdfkit";

export type ReportStatus = "DRAFT" | "SUBMITTED" | "FORWARDED" | "RETURNED" | "REJECTED" | "APPROVED";

export type ReportLineSnapshot = {
  manifestLineId: string;
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
  remarks: string;
};

export type ReportReviewEvent = {
  decision: string;
  actorName: string;
  reason: string;
  createdAt: string;
};

export type ReportSnapshot = {
  legacy?: boolean;
  id: string | null;
  status: ReportStatus;
  version: number;
  runVersion?: number;
  flight: {
    id: string;
    flightNumber: string;
    serviceDate: string;
    aircraft: string;
    status: string;
    sectors: Array<{
      sequence: number;
      origin: string;
      destination: string;
      scheduledDeparture: string;
      scheduledArrival: string;
      economyPax: number;
      businessPax: number;
    }>;
  };
  purser: { id: string | null; name: string; email: string };
  pursers?: Array<{ id: string | null; name: string; email: string }>;
  notes: string;
  submittedAt: string | null;
  approvedAt: string | null;
  lines: ReportLineSnapshot[];
  reviewHistory: ReportReviewEvent[];
};

const formulaPrefix = /^[=+\-@]/;
const safeText = (value: unknown) => {
  const text = value === null || value === undefined ? "" : String(value);
  const withoutLeadingControls = text.replace(/^[\s\u0000-\u001f]+/, "");
  return formulaPrefix.test(withoutLeadingControls) ? `'${text}` : text;
};
const csvCell = (value: unknown) => {
  const text = safeText(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function reportTotals(snapshot: ReportSnapshot) {
  const totals = new Map<string, ReportLineSnapshot>();
  for (const line of snapshot.lines) {
    const key = `${line.sector}|${line.cabin}|${line.unit}`;
    const current = totals.get(key);
    if (!current) {
      totals.set(key, { ...line, sku: "TOTAL", item: "Total" });
      continue;
    }
    for (const field of ["loaded", "consumed", "returned", "spoiled", "discarded", "unexplained"] as const)
      current[field] += line[field];
  }
  return [...totals.values()].sort((a, b) => a.sector - b.sector || a.cabin.localeCompare(b.cabin) || a.unit.localeCompare(b.unit));
}

export function serializeReportCsv(snapshot: ReportSnapshot) {
  const header = ["record_type", "report_id", "status", "version", "service_date", "submitted_at", "approved_at", "purser_id", "purser_name", "purser_email", "flight_number", "aircraft", "sector", "origin", "destination", "scheduled_departure", "scheduled_arrival", "economy_pax", "business_pax", "cabin", "sku", "item", "unit", "loaded", "consumed", "returned", "spoiled", "discarded", "unexplained", "remarks", "flight_notes", "review_decision", "review_actor", "review_at", "review_reason"];
  const common = {
    report_id: snapshot.id, status: snapshot.status, version: snapshot.version,
    service_date: snapshot.flight.serviceDate, submitted_at: snapshot.submittedAt,
    approved_at: snapshot.approvedAt, purser_id: snapshot.purser.id,
    purser_name: snapshot.purser.name, purser_email: snapshot.purser.email,
    flight_number: snapshot.flight.flightNumber, aircraft: snapshot.flight.aircraft,
    flight_notes: snapshot.notes,
  };
  const row = (data: Record<string, unknown>) => header.map((column) => csvCell(data[column])).join(",");
  const lineRow = (line: ReportLineSnapshot, record_type: string) => {
    const sector = snapshot.flight.sectors.find((entry) => entry.sequence === line.sector);
    return row({ ...common, ...line, record_type, scheduled_departure: sector?.scheduledDeparture,
      scheduled_arrival: sector?.scheduledArrival, economy_pax: sector?.economyPax, business_pax: sector?.businessPax });
  };
  return [header.join(","), ...snapshot.lines.map((line) => lineRow(line, "LINE")),
    ...reportTotals(snapshot).map((line) => lineRow({ ...line, remarks: "" }, "TOTAL")),
    row({ ...common, record_type: "NOTES" }),
    ...(snapshot.pursers || []).map((purser) => row({ ...common, record_type: "TEAM_MEMBER", purser_id: purser.id, purser_name: purser.name, purser_email: purser.email })),
    ...snapshot.reviewHistory.map((event) => row({ ...common, record_type: "REVIEW", review_decision: event.decision,
      review_actor: event.actorName, review_at: event.createdAt, review_reason: event.reason })),
  ].join("\r\n") + "\r\n";
}

export async function renderReportPdf(snapshot: ReportSnapshot): Promise<Buffer> {
  const document = new PDFDocument({ size: "A4", margins: { top: 40, left: 40, right: 40, bottom: 64 }, bufferPages: true, compress: false });
  const chunks: Buffer[] = [];
  document.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
  });
  const heading = (text: string) => {
    if (document.y > document.page.height - document.page.margins.bottom - 48) document.addPage();
    document.font("Helvetica-Bold").fontSize(12).text(text, { paragraphGap: 4 });
  };
  heading("RwandAir leftovers report");
  document.font("Helvetica").fontSize(9).text(`Report ID: ${snapshot.id || "Draft"}   Status: ${snapshot.status}   Revision: ${snapshot.version}`);
  document.text(`Flight: ${snapshot.flight.flightNumber}   Service date: ${snapshot.flight.serviceDate}${snapshot.flight.aircraft ? `   Aircraft: ${snapshot.flight.aircraft}` : ""}`);
  for (const purser of snapshot.pursers?.length ? snapshot.pursers : [snapshot.purser])
    document.text(`Purser: ${purser.name} <${purser.email}>`);
  document.text(`Submitted: ${snapshot.submittedAt || "Not submitted"}   Approved: ${snapshot.approvedAt || "Not approved"}`);
  document.moveDown(0.5);
  if (snapshot.flight.sectors.length) {
    heading("Sectors");
    for (const sector of snapshot.flight.sectors)
      document.font("Helvetica").fontSize(8).text(`Sector ${sector.sequence}: ${sector.origin} -> ${sector.destination} | ${sector.scheduledDeparture} - ${sector.scheduledArrival} | Economy ${sector.economyPax}, Business ${sector.businessPax}`);
    document.moveDown(0.5);
  }
  heading("Catering lines");
  for (const line of snapshot.lines) {
    const detail = `${line.sector} ${line.cabin} ${line.item} (${line.sku}, ${line.unit})\nLoaded ${line.loaded} | Consumed ${line.consumed} | Returned ${line.returned} | Spoiled ${line.spoiled} | Discarded ${line.discarded} | Unexplained ${line.unexplained}${line.remarks ? `\nRemark: ${line.remarks}` : ""}`;
    document.font("Helvetica").fontSize(8);
    const options = { width: 515, paragraphGap: 2, lineGap: 1 };
    const height = document.heightOfString(detail, options);
    if (height < document.page.height - document.page.margins.top - document.page.margins.bottom && document.y + height > document.page.height - document.page.margins.bottom) document.addPage();
    document.text(detail, options);
  }
  document.moveDown(0.5);
  heading("Totals");
  for (const line of reportTotals(snapshot)) document.font("Helvetica").fontSize(8).text(`${line.sector} ${line.cabin} ${line.unit}: loaded ${line.loaded}, consumed ${line.consumed}, returned ${line.returned}, spoiled ${line.spoiled}, discarded ${line.discarded}, unexplained ${line.unexplained}`);
  document.moveDown(0.5);
  heading("Notes and review history");
  document.font("Helvetica").fontSize(8).text(snapshot.notes || "No flight-level notes.");
  for (const event of snapshot.reviewHistory) document.text(`${event.createdAt} ${event.decision} by ${event.actorName}: ${event.reason}`);
  const range = document.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index++) {
    document.switchToPage(index);
    const bottom = document.page.margins.bottom;
    document.page.margins.bottom = 0;
    document.font("Helvetica").fontSize(7).text(`Page ${index + 1} of ${range.count}`, 40, document.page.height - 40, { align: "right", width: document.page.width - document.page.margins.left - document.page.margins.right, lineBreak: false });
    document.page.margins.bottom = bottom;
  }
  document.end();
  return finished;
}
