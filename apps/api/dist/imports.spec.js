"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const imports_1 = require("./imports");
(0, node_test_1.default)("parses quoted CSV values and escaped quotes", () => {
    strict_1.default.deepEqual((0, imports_1.parseCsv)('a,b\n"Kigali, Rwanda","WB ""435"""'), [
        ["a", "b"],
        ["Kigali, Rwanda", 'WB "435"'],
    ]);
});
(0, node_test_1.default)("rejects duplicate headers and wrong row widths rather than silently overwriting inputs", () => {
    strict_1.default.throws(() => (0, imports_1.csvRecords)("a,a\n1,2", ["a"]), /Duplicate CSV columns/);
    strict_1.default.throws(() => (0, imports_1.csvRecords)("a,b\n1,2", ["a"]), /Unknown CSV columns/);
    strict_1.default.deepEqual((0, imports_1.csvRecords)("a,b\n1", ["a", "b"])[0].errors, ["Too few columns"]);
    strict_1.default.deepEqual((0, imports_1.csvRecords)("a,b\n1,2,3", ["a", "b"])[0].errors, ["Too many columns"]);
    strict_1.default.deepEqual((0, imports_1.csvRecords)("\uFEFFa,b\r\n1,2\r\n", ["a", "b"])[0].data, { a: "1", b: "2" });
});
(0, node_test_1.default)("requires explicit timestamp offsets and rejects invalid calendar times", () => {
    strict_1.default.equal((0, imports_1.parseIsoTimestamp)("2026-11-04T00:30:00+02:00")?.toISOString(), "2026-11-03T22:30:00.000Z");
    strict_1.default.equal((0, imports_1.parseIsoTimestamp)("2026-11-04T00:30Z")?.toISOString(), "2026-11-04T00:30:00.000Z");
    for (const invalid of ["2026-11-04T08:00:00", "2026-02-30T08:00:00Z", "2026-11-04T24:00:00Z", "2026-11-04T08:61:00Z", "2026-11-04T08:00:00+14:30", "2026-11-04T08:00:00+02:99"]) {
        strict_1.default.equal((0, imports_1.parseIsoTimestamp)(invalid), null, invalid);
    }
});
(0, node_test_1.default)("shipped flight and catering templates describe the same flight/date and valid sectors", () => {
    const flights = (0, imports_1.csvRecords)((0, node_fs_1.readFileSync)((0, node_path_1.resolve)(process.cwd(), "../../docs/flights-template.csv"), "utf8"), imports_1.importHeaders.FLIGHTS);
    const catering = (0, imports_1.csvRecords)((0, node_fs_1.readFileSync)((0, node_path_1.resolve)(process.cwd(), "../../docs/catering-template.csv"), "utf8"), imports_1.importHeaders.CATERING);
    const sectors = new Set(flights.map(({ data }) => `${(0, imports_1.normalizeFlightNumber)(data.flight_number)}|${data.flight_date}|${data.sector_sequence}`));
    for (const { data, errors } of catering) {
        strict_1.default.equal(sectors.has(`${(0, imports_1.normalizeFlightNumber)(data.flight_number)}|${data.flight_date}|${data.sector_sequence}`), true);
        strict_1.default.deepEqual(errors, []);
    }
});
(0, node_test_1.default)("normalizes flight numbers consistently", () => {
    strict_1.default.equal((0, imports_1.normalizeFlightNumber)("wb435"), "WB 435");
    strict_1.default.equal((0, imports_1.normalizeFlightNumber)("WB 435"), "WB 435");
    strict_1.default.equal((0, imports_1.normalizeFlightNumber)("KQ435"), null);
});
(0, node_test_1.default)("validates required columns and numeric inputs", () => {
    strict_1.default.throws(() => (0, imports_1.csvRecords)("a,b\n1,2", ["flight_number"]));
    strict_1.default.equal((0, imports_1.nonnegativeInteger)("12"), 12);
    strict_1.default.equal((0, imports_1.nonnegativeInteger)("-1"), null);
    strict_1.default.ok((0, imports_1.dateWindow)("2026-09-01"));
    strict_1.default.equal((0, imports_1.dateWindow)("01/09/2026"), null);
    strict_1.default.equal((0, imports_1.dateWindow)("2026-02-30"), null);
    strict_1.default.equal((0, imports_1.isoCalendarDate)("2026-09-01T08:00:00+02:00"), "2026-09-01");
});
