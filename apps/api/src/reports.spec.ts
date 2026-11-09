import assert from "node:assert/strict";
import test from "node:test";
import { renderReportPdf, reportTotals, serializeReportCsv, type ReportSnapshot } from "./reports";
import { parseCsv } from "./imports";

const base: ReportSnapshot = {
  id: "r1",
  status: "SUBMITTED",
  version: 2,
  flight: {
    id: "f1",
    flightNumber: "WB 700",
    serviceDate: "2026-11-04",
    aircraft: "A330-300",
    status: "COMPLETED",
    sectors: [{ sequence: 1, origin: "KGL", destination: "NBO", scheduledDeparture: "2026-11-04T06:00:00Z", scheduledArrival: "2026-11-04T08:00:00Z", economyPax: 100, businessPax: 10 }],
  },
  purser: { id: "u1", name: "Mugisha Éric", email: "purser@example.test" },
  pursers: [{ id: "u1", name: "Mugisha Éric", email: "purser@example.test" }, { id: "u2", name: "Uwase Keza", email: "relief@example.test" }],
  notes: "Variance reviewed",
  submittedAt: "2026-11-04T09:00:00Z",
  approvedAt: null,
  lines: [{ manifestLineId: "l1", sector: 1, origin: "KGL", destination: "NBO", cabin: "ECONOMY", sku: "MEAL-CHK", item: "Chicken meal", unit: "meal", loaded: 10, consumed: 7, returned: 2, spoiled: 1, discarded: 0, unexplained: 0, remarks: "=SUM(A1:A2)" }],
  reviewHistory: [{ decision: "SUBMITTED", actorName: "Mugisha Éric", reason: "", createdAt: "2026-11-04T09:00:00Z" }],
};

test("CSV preserves all report metadata and neutralizes formula text", () => {
  const csv = serializeReportCsv(base);
  assert.match(csv, /Mugisha Éric/);
  assert.match(csv, /Uwase Keza/);
  assert.match(csv, /'=?SUM\(A1:A2\)/);
  assert.match(csv, /Variance reviewed/);
  assert.match(csv, /\r\n/);
  const records = parseCsv(csv);
  assert.ok(records.every((row) => row.length === records[0].length));
  assert.equal(records.filter((row) => row[0] === "TEAM_MEMBER").length, 2);
  const actorColumn = records[0].indexOf("review_actor");
  assert.equal(records.find((row) => row[0] === "REVIEW")?.[actorColumn], "Mugisha Éric");
  for (const remarks of ["=SUM(A1:A2)", "\t=1+1", "\r@SUM(A1:A2)", "  +1+1", "-1+1"]) {
    const guarded = parseCsv(serializeReportCsv({ ...base, lines: [{ ...base.lines[0], remarks }] }));
    assert.ok(guarded[1][guarded[0].indexOf("remarks")].startsWith("'"));
  }
});

test("totals remain separated by sector, cabin and unit", () => {
  const snapshot = { ...base, lines: [...base.lines, { ...base.lines[0], manifestLineId: "l2", unit: "bottle", loaded: 4, consumed: 2, returned: 2, spoiled: 0, discarded: 0, unexplained: 0 }] };
  const totals = reportTotals(snapshot);
  assert.equal(totals.length, 2);
  assert.deepEqual(totals.map((line) => line.unit), ["bottle", "meal"]);
});

test("PDF paginates complete reports and preserves every item and remark", async () => {
  const snapshot = { ...base, lines: Array.from({ length: 100 }, (_, index) => ({ ...base.lines[0], manifestLineId: `line-${index}`, item: `Item ${index}` })) };
  const pdf = await renderReportPdf(snapshot);
  assert.match(pdf.subarray(0, 8).toString(), /^%PDF-1\.[34]/);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loaded = await pdfjs.getDocument({ data: new Uint8Array(pdf) }).promise;
  let extracted = "";
  const pageText: string[] = [];
  for (let page = 1; page <= loaded.numPages; page++) {
    const content = await loaded.getPage(page).then((item) => item.getTextContent());
    const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
    pageText.push(text);
    extracted += text;
  }
  assert.ok(loaded.numPages > 1);
  assert.equal(pageText.length, new Set(pageText).size);
  assert.ok(pageText.every((text, index) => text.includes(`Page ${index + 1} of ${loaded.numPages}`) && text.trim().length > 40));
  assert.match(extracted, /Item 0/);
  assert.match(extracted, /Item 99/);
  assert.match(extracted, /Remark/);
  assert.match(extracted, /Mugisha Éric/);
  assert.match(extracted, /Uwase Keza/);
});
