"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mergeConsumptionLines = mergeConsumptionLines;
/** Preserve independent edits; require a choice when both users changed one field. */
function mergeConsumptionLines(base, local, server) {
    const originals = new Map(base.map((line) => [line.id, line]));
    const edits = new Map(local.map((line) => [line.id, line]));
    const conflicts = [];
    const lines = server.map((line) => {
        const original = originals.get(line.id), edit = edits.get(line.id);
        const merged = { ...line };
        if (!original || !edit)
            return merged;
        for (const field of ["consumed", "remarks"]) {
            const before = field === "remarks" ? original[field] || "" : original[field];
            const mine = field === "remarks" ? edit[field] || "" : edit[field];
            const theirs = field === "remarks" ? line[field] || "" : line[field];
            if (mine === before)
                continue;
            if (theirs !== before && theirs !== mine)
                conflicts.push({ id: line.id, field, local: mine, server: theirs });
            else
                Object.assign(merged, { [field]: mine });
        }
        return merged;
    });
    return { lines, conflicts };
}
