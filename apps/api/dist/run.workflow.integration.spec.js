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
const node_crypto_1 = require("node:crypto");
const node_test_1 = __importDefault(require("node:test"));
const client_1 = require("@prisma/client");
const argon2_1 = require("argon2");
const test_fixtures_1 = require("./test-fixtures");
const testUrl = process.env.TEST_DATABASE_URL;
(0, node_test_1.default)("run workflow: imports, assigns multiple Pursers, generates and approves without a schedule", { skip: !testUrl }, async (t) => {
    strict_1.default.match(new URL(testUrl).pathname, /test|verification/i, "TEST_DATABASE_URL must identify an isolated test database");
    process.env.DATABASE_URL = testUrl;
    const db = new client_1.PrismaClient({ datasourceUrl: testUrl });
    const { AppController } = await Promise.resolve().then(() => __importStar(require("./app")));
    const controller = new AppController();
    const call = (method, ...args) => controller[method](...args);
    const prefix = (0, node_crypto_1.randomUUID)().slice(0, 8);
    const flightDigits = "9101";
    const passwordHash = await (0, argon2_1.hash)("Run-only-integration-password-2026");
    const accounts = await Promise.all([
        { role: client_1.Role.PROCUREMENT, name: "Run Catering" },
        { role: client_1.Role.LEAD, name: "Run Cabin Services" },
        { role: client_1.Role.ATTENDANT, name: "Run Flight Purser" },
        { role: client_1.Role.ATTENDANT, name: "Run Relief Purser" },
        { role: client_1.Role.DIRECTOR, name: "Run Director" },
    ].map((account, index) => db.user.create({ data: { ...account, email: `${prefix}-${index}@run.test`, passwordHash } })));
    const requests = await Promise.all(accounts.map(async (account) => {
        const csrfToken = (0, node_crypto_1.randomUUID)();
        const session = await db.session.create({ data: { id: (0, node_crypto_1.randomUUID)(), userId: account.id, csrfToken, expiresAt: new Date(Date.now() + 3_600_000) } });
        return { cookies: { wb_session: session.id }, headers: { "x-csrf-token": csrfToken } };
    }));
    const [cateringReq, leadReq, purserReq, reliefPurserReq, directorReq] = requests;
    const itemSku = `RUN-MEAL-${prefix.toUpperCase()}`;
    const item = await db.catalogItem.create({
        data: {
            sku: itemSku,
            nameEn: `Run chicken meal ${prefix}`,
            nameFr: "Repas run",
            category: "Meals",
            unit: "meal",
            prices: { create: { amountMinor: 1000, effectiveFrom: new Date("2020-01-01") } },
            lots: { create: { lotCode: prefix, quantity: 1000 } },
        },
    });
    const csv = [
        "flight_number,service_date,item,loaded",
        `WB ${flightDigits},2026-11-04,${item.nameEn},12`,
    ].join("\n");
    try {
        await t.test("the catering import creates a standalone run", async () => {
            const preview = await call("previewImport", { type: "CATERING", fileName: "run.csv", csv }, cateringReq);
            strict_1.default.equal(preview.errorCount, 0);
            await call("commitImport", preview.id, cateringReq);
            const runs = await call("runs", cateringReq);
            const created = runs.find((run) => run.flightNumber === `WB ${flightDigits}`);
            strict_1.default.ok(created);
            strict_1.default.equal(new Date(created.serviceDate).toISOString().slice(0, 10), "2026-11-04");
            strict_1.default.equal(created.status, "READY");
        });
        const runs = await call("runs", cateringReq);
        const run = runs.find((entry) => entry.flightNumber === `WB ${flightDigits}`);
        strict_1.default.ok(run);
        await t.test("lead and purser assignments are owned by the run", async () => {
            await call("assignRunLead", run.id, { leadId: accounts[1].id, version: run.version }, cateringReq);
            const leadRun = (await call("runs", leadReq)).find((entry) => entry.id === run.id);
            await call("assignRunPursers", run.id, { purserIds: [accounts[2].id, accounts[3].id], version: leadRun.version }, leadReq);
            const visible = await call("runs", purserReq);
            strict_1.default.equal(visible[0].id, run.id);
            strict_1.default.equal(visible[0].lead?.id, accounts[1].id);
            strict_1.default.deepEqual(visible[0].pursers?.map((entry) => entry.id), [accounts[2].id, accounts[3].id]);
            const reliefRuns = await call("runs", reliefPurserReq);
            strict_1.default.equal(reliefRuns[0].id, run.id);
            const [leadNotice, purserNotice] = await Promise.all([
                db.notification.findFirst({ where: { userId: accounts[1].id, kind: "RUN_ASSIGNED" } }),
                db.notification.findFirst({ where: { userId: accounts[2].id, kind: "PURSER_ASSIGNED" } }),
            ]);
            strict_1.default.equal(leadNotice?.actionPath, "operations");
            strict_1.default.equal(purserNotice?.actionPath, "my-runs");
        });
        await t.test("shared leftovers and lead-generated report reach Catering approval", async () => {
            const assignedRun = (await call("runs", purserReq))[0];
            strict_1.default.equal(assignedRun.id, run.id);
            const draft = {
                version: assignedRun.version,
                lines: assignedRun.lines.map((line) => ({ id: line.id, consumed: 8, remarks: "Run-only count" })),
            };
            const conflict = (error) => error.getStatus?.() === 409;
            await strict_1.default.rejects(call("generateRunReport", run.id, { operationId: (0, node_crypto_1.randomUUID)(), runVersion: assignedRun.version }, leadReq), conflict);
            strict_1.default.equal(await db.cateringRunReport.count({ where: { cateringListId: run.id } }), 0);
            const zero = await call("saveRunDraft", run.id, { ...draft, lines: draft.lines.map((line) => ({ ...line, consumed: 0 })) }, purserReq);
            const zeroPreview = await call("previewRunReport", run.id, leadReq);
            strict_1.default.equal(zeroPreview.lines[0].returned, 12);
            strict_1.default.equal(zeroPreview.lines[0].unexplained, 0);
            // Two Pursers must not overwrite each other with the same base version.
            const race = await Promise.allSettled([purserReq, reliefPurserReq].map((req) => call("saveRunDraft", run.id, { ...draft, version: zero.version }, req)));
            strict_1.default.equal(race.filter((result) => result.status === "fulfilled").length, 1);
            strict_1.default.equal(race.filter((result) => result.status === "rejected" && conflict(result.reason)).length, 1);
            await strict_1.default.rejects(call("generateRunReport", run.id, { operationId: (0, node_crypto_1.randomUUID)(), runVersion: zeroPreview.runVersion }, leadReq), conflict);
            const preview = await call("previewRunReport", run.id, leadReq);
            strict_1.default.equal(preview.id, null);
            strict_1.default.equal(preview.status, "DRAFT");
            strict_1.default.equal(preview.lines[0].consumed, 8);
            strict_1.default.equal(preview.lines[0].returned, 4);
            strict_1.default.deepEqual(new Set(preview.pursers.map((user) => user.name)), new Set([accounts[2].name, accounts[3].name]));
            // Corrupt/unbalanced data must never become an approved missing-stock charge.
            await db.cateringListLine.update({ where: { id: assignedRun.lines[0].id }, data: { returned: 0 } });
            await strict_1.default.rejects(call("generateRunReport", run.id, { operationId: (0, node_crypto_1.randomUUID)(), runVersion: preview.runVersion }, leadReq), conflict);
            await db.cateringListLine.update({ where: { id: assignedRun.lines[0].id }, data: { returned: 4 } });
            const operationId = (0, node_crypto_1.randomUUID)();
            const generated = await call("generateRunReport", run.id, { operationId, runVersion: preview.runVersion }, leadReq);
            strict_1.default.equal(generated.status, "FORWARDED");
            const replay = await call("generateRunReport", run.id, { operationId, runVersion: preview.runVersion }, leadReq);
            strict_1.default.equal(replay.id, generated.id);
            await strict_1.default.rejects(call("generateRunReport", run.id, { operationId, runVersion: preview.runVersion + 1 }, leadReq), conflict);
            const cateringNotice = await db.notification.findFirst({ where: { userId: accounts[0].id, kind: "REPORT_READY" } });
            strict_1.default.equal(cateringNotice?.actionPath, "reconciliation");
            await call("decideRunReport", generated.id, { decision: "RETURNED", reason: "Please recount the meals", version: generated.version, operationId: (0, node_crypto_1.randomUUID)() }, cateringReq);
            const returned = await call("previewRunReport", run.id, leadReq);
            strict_1.default.ok(returned.reviewHistory.some((event) => event.reason === "Please recount the meals"));
            const returnedRun = (await call("runs", purserReq)).find((entry) => entry.id === run.id);
            strict_1.default.equal(returnedRun.report.returnReason, "Please recount the meals");
            strict_1.default.equal(await db.notification.count({ where: { userId: accounts[3].id, kind: "REPORT_RETURNED", actionPath: "my-runs" } }), 1);
            const correctedPreview = await call("previewRunReport", run.id, leadReq);
            const corrected = await call("generateRunReport", run.id, { operationId: (0, node_crypto_1.randomUUID)(), runVersion: correctedPreview.runVersion }, leadReq);
            strict_1.default.equal(corrected.version, 2);
            await db.user.update({ where: { id: accounts[3].id }, data: { name: "Renamed after submission" } });
            const frozen = await call("runReportDetails", run.id, cateringReq);
            strict_1.default.ok(frozen.pursers.some((user) => user.name === accounts[3].name));
            const csvReport = await call("runReportCsv", run.id, cateringReq, { setHeader() { } });
            strict_1.default.match(csvReport, /Run Flight Purser/);
            strict_1.default.match(csvReport, /Run Relief Purser/);
            const approvals = await Promise.allSettled([(0, node_crypto_1.randomUUID)(), (0, node_crypto_1.randomUUID)()].map((operationId) => call("decideRunReport", corrected.id, { decision: "APPROVED", version: corrected.version, operationId }, cateringReq)));
            strict_1.default.equal(approvals.filter((result) => result.status === "fulfilled").length, 1);
            strict_1.default.equal(await db.stockMovement.count({ where: { runId: run.id } }), 2);
            const operations = await call("operationsDashboard", directorReq);
            strict_1.default.ok(operations.approved >= 1);
            strict_1.default.ok(operations.consumed >= 8);
            strict_1.default.ok(operations.returned >= 4);
            const directorNotice = await db.notification.findFirst({ where: { userId: accounts[4].id, kind: "ANALYTICS_UPDATED" } });
            strict_1.default.equal(directorNotice?.actionPath, "executive");
        });
        await t.test("cancelled runs remain read-only and reserve no stock", async () => {
            const cancelled = await db.cateringList.create({ data: {
                    name: `Cancelled ${prefix}`, flightNumber: "WB 9103", serviceDate: new Date("2030-01-01"), createdById: accounts[0].id,
                    leadId: accounts[1].id, purserId: accounts[2].id, status: "CANCELLED", pursers: { create: { userId: accounts[2].id } },
                    lines: { create: { itemId: item.id, sectorSequence: 1, cabin: "ECONOMY", suggested: 5, planned: 5, approved: 5, loaded: 5 } },
                }, include: { lines: true } });
            const conflict = (error) => error.getStatus?.() === 409;
            await strict_1.default.rejects(call("assignRunLead", cancelled.id, { leadId: accounts[1].id, version: 1 }, cateringReq), conflict);
            await strict_1.default.rejects(call("addRunPurser", cancelled.id, { purserId: accounts[3].id, version: 1 }, leadReq), conflict);
            await strict_1.default.rejects(call("saveRunDraft", cancelled.id, { version: 1, lines: cancelled.lines.map((line) => ({ id: line.id, consumed: 1 })) }, purserReq), conflict);
            await strict_1.default.rejects(call("generateRunReport", cancelled.id, { operationId: (0, node_crypto_1.randomUUID)(), runVersion: 1 }, leadReq), conflict);
            const stock = await call("stock", cateringReq);
            strict_1.default.equal(stock.find((entry) => entry.id === item.id)?.reserved, 0);
        });
        await t.test("dashboard totals include more than 250 reports and only current revisions", async () => {
            const before = await call("operationsDashboard", directorReq);
            const records = Array.from({ length: 251 }, (_, index) => ({ id: `${prefix}-run-${index}`, name: `${prefix} analytics ${index}`, flightNumber: "WB 9102", serviceDate: new Date(Date.UTC(2030, 0, index + 1)), createdById: accounts[0].id }));
            await db.cateringList.createMany({ data: records });
            await db.cateringRunReport.createMany({ data: records.map((record, index) => ({ id: `${prefix}-report-${index}`, cateringListId: record.id, purserId: accounts[2].id, purserName: accounts[2].name, status: "APPROVED", version: 2, submittedAt: new Date() })) });
            const quantities = { itemId: item.id, itemSku: item.sku, itemName: item.nameEn, unit: item.unit, sectorSequence: 1, cabin: "ECONOMY", loaded: 10, consumed: 6, returned: 4, spoiled: 0, discarded: 0, unexplained: 0 };
            await db.cateringRunReportLine.createMany({ data: records.map((_, index) => ({ ...quantities, reportId: `${prefix}-report-${index}`, revision: 2 })) });
            await db.cateringRunReportLine.create({ data: { ...quantities, loaded: 1000, consumed: 1000, returned: 0, reportId: `${prefix}-report-0`, revision: 1 } });
            const after = await call("operationsDashboard", directorReq);
            strict_1.default.equal(after.approved, before.approved + 251);
            strict_1.default.equal(after.loaded, before.loaded + 2510);
            strict_1.default.equal(after.consumed, before.consumed + 1506);
            strict_1.default.equal(after.returned, before.returned + 1004);
            strict_1.default.equal(after.recent.length, 6);
        });
    }
    finally {
        try {
            await (0, test_fixtures_1.cleanupRunFixtures)(db, accounts.map((account) => account.id), [item.id]);
        }
        finally {
            await db.$disconnect();
        }
    }
});
