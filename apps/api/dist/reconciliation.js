"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.unexplained = unexplained;
exports.wasteCostMinor = wasteCostMinor;
function unexplained(x) { const value = x.loaded - x.consumed - x.returned - x.spoiled - x.discarded; if (value < 0)
    throw new Error('Accounted quantity cannot exceed loaded quantity'); return value; }
function wasteCostMinor(x, unitCostMinor) { return (x.spoiled + x.discarded + unexplained(x)) * unitCostMinor; }
