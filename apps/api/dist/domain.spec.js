"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const client_1 = require("@prisma/client");
const domain_1 = require("./domain");
(0, node_test_1.default)("only draft and returned reports can be submitted", () => { strict_1.default.equal((0, domain_1.canSubmitReport)(null), true); strict_1.default.equal((0, domain_1.canSubmitReport)(client_1.ReportStatus.RETURNED), true); strict_1.default.equal((0, domain_1.canSubmitReport)(client_1.ReportStatus.SUBMITTED), false); strict_1.default.equal((0, domain_1.canSubmitReport)(client_1.ReportStatus.APPROVED), false); });
(0, node_test_1.default)("role policies are explicit", () => { strict_1.default.equal((0, domain_1.canAccess)(client_1.Role.DIRECTOR, [client_1.Role.DIRECTOR]), true); strict_1.default.equal((0, domain_1.canAccess)(client_1.Role.ATTENDANT, [client_1.Role.PROCUREMENT, client_1.Role.DIRECTOR]), false); });
(0, node_test_1.default)("stock applies consumption but does not double-count informational returns", () => strict_1.default.equal((0, domain_1.onHandQuantity)([100], [{ quantity: -20, reason: "APPROVED_CONSUMPTION" }, { quantity: 5, reason: "RETURN" }]), 80));
(0, node_test_1.default)("missing stock reduces on-hand quantity", () => strict_1.default.equal((0, domain_1.onHandQuantity)([100], [{ quantity: -4, reason: "MISSING" }]), 96));
(0, node_test_1.default)("price selection uses the flight date rather than the newest price", () => {
    const old = { amountMinor: 500, effectiveFrom: new Date("2026-01-01"), effectiveTo: new Date("2026-07-01") };
    const current = { amountMinor: 650, effectiveFrom: new Date("2026-07-01"), effectiveTo: null };
    strict_1.default.equal((0, domain_1.effectivePriceAt)([current, old], new Date("2026-06-15"))?.amountMinor, 500);
});
(0, node_test_1.default)("Lead forwards and Procurement performs final approval", () => {
    strict_1.default.equal((0, domain_1.canDecideReport)(client_1.Role.LEAD, client_1.ReportStatus.SUBMITTED, client_1.ReportStatus.FORWARDED), true);
    strict_1.default.equal((0, domain_1.canDecideReport)(client_1.Role.LEAD, client_1.ReportStatus.SUBMITTED, client_1.ReportStatus.APPROVED), false);
    strict_1.default.equal((0, domain_1.canDecideReport)(client_1.Role.PROCUREMENT, client_1.ReportStatus.FORWARDED, client_1.ReportStatus.APPROVED), true);
});
(0, node_test_1.default)("back-to-back flights do not overlap", () => {
    const first = { start: new Date("2026-09-01T08:00:00Z"), end: new Date("2026-09-01T10:00:00Z") };
    const next = { start: new Date("2026-09-01T10:00:00Z"), end: new Date("2026-09-01T12:00:00Z") };
    const conflict = { start: new Date("2026-09-01T09:30:00Z"), end: new Date("2026-09-01T11:00:00Z") };
    strict_1.default.equal((0, domain_1.schedulesOverlap)(first, next), false);
    strict_1.default.equal((0, domain_1.schedulesOverlap)(first, conflict), true);
});
