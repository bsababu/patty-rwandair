"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const forecast_1 = require("./forecast");
(0, node_test_1.default)("forecast falls back to a transparent network default", () => {
    strict_1.default.deepEqual((0, forecast_1.suggestLoad)(100, "KGL-NBO", [], 0.05), {
        baseline: 100,
        safetyBuffer: 5,
        suggested: 105,
        confidence: "LOW",
        sampleSize: 0,
        source: "network default",
    });
});
(0, node_test_1.default)("forecast uses route history once the minimum sample is met", () => {
    const history = Array.from({ length: 5 }, (_, index) => ({
        consumed: 80,
        passengers: 100,
        route: "KGL-NBO",
        ageDays: index + 1,
    }));
    const result = (0, forecast_1.suggestLoad)(150, "KGL-NBO", history, 0.05);
    strict_1.default.equal(result.baseline, 120);
    strict_1.default.equal(result.suggested, 126);
    strict_1.default.equal(result.source, "route recent average");
    strict_1.default.equal(result.confidence, "MEDIUM");
});
