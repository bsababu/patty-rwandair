"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const reconciliation_1 = require("./reconciliation");
(0, node_test_1.default)('calculates unexplained stock', () => strict_1.default.equal((0, reconciliation_1.unexplained)({ loaded: 100, consumed: 72, returned: 20, spoiled: 3, discarded: 2 }), 3));
(0, node_test_1.default)('prices waste in integer minor units', () => strict_1.default.equal((0, reconciliation_1.wasteCostMinor)({ loaded: 10, consumed: 6, returned: 1, spoiled: 1, discarded: 1 }, 750), 2250));
(0, node_test_1.default)('rejects over-accounting', () => strict_1.default.throws(() => (0, reconciliation_1.unexplained)({ loaded: 4, consumed: 5, returned: 0, spoiled: 0, discarded: 0 })));
