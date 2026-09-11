"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const imports_1 = require("./imports");
(0, node_test_1.default)("parses quoted CSV values and escaped quotes", () => {
    strict_1.default.deepEqual((0, imports_1.parseCsv)('a,b\n"Kigali, Rwanda","WB ""435"""'), [
        ["a", "b"],
        ["Kigali, Rwanda", 'WB "435"'],
    ]);
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
});
