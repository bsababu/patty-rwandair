"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const reports_1 = require("./reports");
const imports_1 = require("./imports");
const base = {
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
(0, node_test_1.default)("CSV preserves all report metadata and neutralizes formula text", () => {
    const csv = (0, reports_1.serializeReportCsv)(base);
    strict_1.default.match(csv, /Mugisha Éric/);
    strict_1.default.match(csv, /Uwase Keza/);
    strict_1.default.match(csv, /'=?SUM\(A1:A2\)/);
    strict_1.default.match(csv, /Variance reviewed/);
    strict_1.default.match(csv, /\r\n/);
    const records = (0, imports_1.parseCsv)(csv);
    strict_1.default.ok(records.every((row) => row.length === records[0].length));
    strict_1.default.equal(records.filter((row) => row[0] === "TEAM_MEMBER").length, 2);
    const actorColumn = records[0].indexOf("review_actor");
    strict_1.default.equal(records.find((row) => row[0] === "REVIEW")?.[actorColumn], "Mugisha Éric");
    for (const remarks of ["=SUM(A1:A2)", "\t=1+1", "\r@SUM(A1:A2)", "  +1+1", "-1+1"]) {
        const guarded = (0, imports_1.parseCsv)((0, reports_1.serializeReportCsv)({ ...base, lines: [{ ...base.lines[0], remarks }] }));
        strict_1.default.ok(guarded[1][guarded[0].indexOf("remarks")].startsWith("'"));
    }
});
(0, node_test_1.default)("totals remain separated by sector, cabin and unit", () => {
    const snapshot = { ...base, lines: [...base.lines, { ...base.lines[0], manifestLineId: "l2", unit: "bottle", loaded: 4, consumed: 2, returned: 2, spoiled: 0, discarded: 0, unexplained: 0 }] };
    const totals = (0, reports_1.reportTotals)(snapshot);
    strict_1.default.equal(totals.length, 2);
    strict_1.default.deepEqual(totals.map((line) => line.unit), ["bottle", "meal"]);
});
(0, node_test_1.default)("PDF paginates complete reports and preserves every item and remark", async () => {
    const snapshot = { ...base, lines: Array.from({ length: 100 }, (_, index) => ({ ...base.lines[0], manifestLineId: `line-${index}`, item: `Item ${index}` })) };
    const pdf = await (0, reports_1.renderReportPdf)(snapshot);
    strict_1.default.match(pdf.subarray(0, 8).toString(), /^%PDF-1\.[34]/);
    const pdfjs = await Promise.resolve().then(() => __importStar(require("pdfjs-dist/legacy/build/pdf.mjs")));
    const loaded = await pdfjs.getDocument({ data: new Uint8Array(pdf) }).promise;
    let extracted = "";
    const pageText = [];
    for (let page = 1; page <= loaded.numPages; page++) {
        const content = await loaded.getPage(page).then((item) => item.getTextContent());
        const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
        pageText.push(text);
        extracted += text;
    }
    strict_1.default.ok(loaded.numPages > 1);
    strict_1.default.equal(pageText.length, new Set(pageText).size);
    strict_1.default.ok(pageText.every((text, index) => text.includes(`Page ${index + 1} of ${loaded.numPages}`) && text.trim().length > 40));
    strict_1.default.match(extracted, /Item 0/);
    strict_1.default.match(extracted, /Item 99/);
    strict_1.default.match(extracted, /Remark/);
    strict_1.default.match(extracted, /Mugisha Éric/);
    strict_1.default.match(extracted, /Uwase Keza/);
});
