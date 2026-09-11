"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.canDecideReport = exports.schedulesOverlap = exports.onHandQuantity = exports.canAccess = exports.canSubmitReport = void 0;
exports.effectivePriceAt = effectivePriceAt;
const client_1 = require("@prisma/client");
const canSubmitReport = (status) => status === null ||
    status === client_1.ReportStatus.DRAFT ||
    status === client_1.ReportStatus.RETURNED;
exports.canSubmitReport = canSubmitReport;
const canAccess = (role, allowed) => allowed.includes(role);
exports.canAccess = canAccess;
const onHandQuantity = (lots, movements) => lots.reduce((sum, quantity) => sum + quantity, 0) +
    movements
        .filter((movement) => movement.reason !== "RETURN")
        .reduce((sum, movement) => sum + movement.quantity, 0);
exports.onHandQuantity = onHandQuantity;
function effectivePriceAt(prices, at) {
    return prices
        .filter((price) => price.effectiveFrom <= at &&
        (!price.effectiveTo || price.effectiveTo > at))
        .sort((left, right) => right.effectiveFrom.getTime() - left.effectiveFrom.getTime())[0];
}
const schedulesOverlap = (left, right) => left.start < right.end && right.start < left.end;
exports.schedulesOverlap = schedulesOverlap;
const canDecideReport = (role, current, next) => role === client_1.Role.LEAD
    ? current === client_1.ReportStatus.SUBMITTED &&
        (next === client_1.ReportStatus.FORWARDED || next === client_1.ReportStatus.RETURNED)
    : role === client_1.Role.PROCUREMENT
        ? current === client_1.ReportStatus.FORWARDED &&
            (next === client_1.ReportStatus.APPROVED ||
                next === client_1.ReportStatus.RETURNED ||
                next === client_1.ReportStatus.REJECTED)
        : false;
exports.canDecideReport = canDecideReport;
