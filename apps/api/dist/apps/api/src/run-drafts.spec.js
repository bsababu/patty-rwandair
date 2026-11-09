"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const run_drafts_1 = require("../../../app/lib/run-drafts");
(0, node_test_1.default)("shared consumption merges independent fields without replacing team edits", () => {
    const base = [{ id: "a", consumed: 0, remarks: "" }, { id: "b", consumed: 0, remarks: "" }];
    const mine = [{ id: "a", consumed: 4, remarks: "" }, base[1]];
    const server = [{ id: "a", consumed: 0, remarks: "Team note" }, { id: "b", consumed: 6, remarks: "" }];
    const result = (0, run_drafts_1.mergeConsumptionLines)(base, mine, server);
    strict_1.default.deepEqual(result.lines, [{ id: "a", consumed: 4, remarks: "Team note" }, server[1]]);
    strict_1.default.deepEqual(result.conflicts, []);
    strict_1.default.equal(server[0].consumed, 0);
});
(0, node_test_1.default)("conflicting edits require a choice and preserve both candidate values", () => {
    const base = [{ id: "a", consumed: 0, remarks: "" }];
    const result = (0, run_drafts_1.mergeConsumptionLines)(base, [{ id: "a", consumed: 4, remarks: "Mine" }], [{ id: "a", consumed: 7, remarks: "Team" }]);
    strict_1.default.deepEqual(result.conflicts, [{ id: "a", field: "consumed", local: 4, server: 7 }, { id: "a", field: "remarks", local: "Mine", server: "Team" }]);
    strict_1.default.equal(result.lines[0].consumed, 7);
    strict_1.default.equal(result.lines[0].remarks, "Team");
});
(0, node_test_1.default)("identical changes and absent optional remarks do not cause false conflicts", () => {
    const result = (0, run_drafts_1.mergeConsumptionLines)([{ id: "a", consumed: 0 }], [{ id: "a", consumed: 4, remarks: "" }], [{ id: "a", consumed: 4, remarks: null }]);
    strict_1.default.deepEqual(result.conflicts, []);
});
