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
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_test_1 = __importDefault(require("node:test"));
const client_1 = require("@prisma/client");
const argon2_1 = require("argon2");
const common_1 = require("@nestjs/common");
const testUrl = process.env.TEST_DATABASE_URL;
const status = (error) => typeof error === "object" && error !== null && "getStatus" in error
    ? error.getStatus() : 0;
(0, node_test_1.default)("real PostgreSQL: imports, purser reports, corrections and once-only stock approval", { skip: !testUrl }, async (t) => {
    strict_1.default.match(new URL(testUrl).pathname, /test|verification/i, "TEST_DATABASE_URL must identify an isolated test database");
    process.env.DATABASE_URL = testUrl;
    const db = new client_1.PrismaClient({ datasourceUrl: testUrl });
    const { AppController } = await Promise.resolve().then(() => __importStar(require("./app")));
    const controller = new AppController();
    const call = (method, ...args) => controller[method](...args);
    const prefix = (0, node_crypto_1.randomUUID)().slice(0, 8);
    const passwordHash = await (0, argon2_1.hash)("Integration-only-password-2026");
    const accounts = await Promise.all([
        { role: client_1.Role.PROCUREMENT, name: "Catering reviewer" },
        { role: client_1.Role.LEAD, name: "Cabin Services reviewer" },
        { role: client_1.Role.ATTENDANT, name: "Mugisha Éric" },
        { role: client_1.Role.ATTENDANT, name: "Legacy cabin crew" },
        { role: client_1.Role.LEAD, name: "Unassigned lead" },
    ].map((account, index) => db.user.create({ data: { ...account, email: `${prefix}-${index}@integration.test`, passwordHash } })));
    const requests = await Promise.all(accounts.map(async (account) => {
        const csrfToken = (0, node_crypto_1.randomUUID)();
        const session = await db.session.create({ data: { id: (0, node_crypto_1.randomUUID)(), userId: account.id, csrfToken, expiresAt: new Date(Date.now() + 3_600_000) } });
        return { cookies: { wb_session: session.id }, headers: { "x-csrf-token": csrfToken } };
    }));
    const [cateringReq, leadReq, purserReq, legacyReq, otherLeadReq] = requests;
    const mealSku = `TEST-MEAL-${prefix.toUpperCase()}`;
    const waterSku = `TEST-WATER-${prefix.toUpperCase()}`;
    const meal = await db.catalogItem.create({ data: { sku: mealSku, nameEn: "Repas végétarien", nameFr: "Repas végétarien", category: "Meals", unit: "meal", prices: { create: { amountMinor: 1000, effectiveFrom: new Date("2020-01-01") } }, lots: { create: { lotCode: prefix, quantity: 1000 } } } });
    await db.catalogItem.create({ data: { sku: waterSku, nameEn: "Water", nameFr: "Eau", category: "Beverages", unit: "bottle", prices: { create: { amountMinor: 100, effectiveFrom: new Date("2020-01-01") } }, lots: { create: { lotCode: prefix, quantity: 1000 } } } });
    const flightNumber = `WB${1000 + Number.parseInt(prefix.slice(0, 4), 16) % 9000}`;
    const flightCsv = [
        "flight_number,flight_date,aircraft,sector_sequence,origin,destination,departure_iso,arrival_iso,economy_pax,business_pax",
        `${flightNumber},2026-11-04,A330-300,1,KGL,NBO,2026-11-04T00:30:00+02:00,2026-11-04T04:00:00+03:00,220,24`,
        `${flightNumber},2026-11-04,A330-300,2,NBO,KGL,2026-11-05T01:30:00+03:00,2026-11-05T03:30:00+02:00,215,22`,
    ].join("\n");
    const cateringCsv = [
        "flight_number,flight_date,sector_sequence,cabin,item_sku,suggested,planned,approved,loaded,override_reason",
        `${flightNumber},2026-11-04,1,ECONOMY,${mealSku},10,10,10,10,`,
        `${flightNumber},2026-11-04,1,BUSINESS,${mealSku},5,5,5,5,`,
        `${flightNumber},2026-11-04,1,ECONOMY,${waterSku},4,4,4,4,`,
        `${flightNumber},2026-11-04,2,BUSINESS,${mealSku},2,2,2,2,`,
    ].join("\n");
    let flightId = "";
    let reportId = "";
    let reportVersion = 0;
    let firstPreviewId = "";
    let firstSnapshot;
    const manifests = () => call("manifest", flightId, purserReq);
    try {
        await t.test("refreshes missing-flight errors after a valid overnight flight import", async () => {
            const before = await call("previewImport", { type: "CATERING", fileName: "catering.csv", csv: cateringCsv }, cateringReq);
            firstPreviewId = before.id;
            strict_1.default.equal(before.errorCount, 4);
            strict_1.default.equal(before.rows.some((row) => row.errors.some((error) => error.includes("Duplicate"))), false);
            const flightPreview = await call("previewImport", { type: "FLIGHTS", fileName: "flights.csv", csv: flightCsv }, cateringReq);
            strict_1.default.equal(flightPreview.errorCount, 0, JSON.stringify(flightPreview.rows));
            const result = await call("commitImport", flightPreview.id, cateringReq);
            flightId = result.ids[0];
            const flight = await db.flight.findUniqueOrThrow({ where: { id: flightId } });
            strict_1.default.equal(flight.serviceDate.toISOString().slice(0, 10), "2026-11-04");
            strict_1.default.equal(flight.flightDate.toISOString().slice(0, 10), "2026-11-03");
            const refreshed = await call("previewImport", { type: "CATERING", fileName: "catering.csv", csv: cateringCsv }, cateringReq);
            strict_1.default.equal(refreshed.id, firstPreviewId);
            strict_1.default.equal(refreshed.errorCount, 0, JSON.stringify(refreshed.rows));
            await call("commitImport", refreshed.id, cateringReq);
            const list = await db.cateringList.findUniqueOrThrow({ where: { flightNumber_serviceDate: { flightNumber: flight.flightNumber, serviceDate: flight.serviceDate } } });
            await db.flight.update({ where: { id: flightId }, data: { leadId: accounts[1].id } });
            await call("attachCateringList", flightId, list.id, { operationId: (0, node_crypto_1.randomUUID)() }, leadReq);
        });
        await t.test("enforces one purser and keeps legacy crew read-only after completion", async () => {
            const flight = await db.flight.findUniqueOrThrow({ where: { id: flightId } });
            await strict_1.default.rejects(call("assignFlightCrew", flightId, { version: flight.version, assignments: [{ userId: accounts[2].id, duty: "PURSER" }, { userId: accounts[3].id, duty: "CABIN_CREW" }] }, leadReq), (error) => status(error) === 400);
            await call("assignFlightCrew", flightId, { operationId: (0, node_crypto_1.randomUUID)(), version: flight.version, assignments: [{ userId: accounts[2].id, duty: "PURSER" }] }, leadReq);
            await db.crewAssignment.create({ data: { flightId, userId: accounts[3].id, duty: "CABIN_CREW" } });
            await db.flight.update({ where: { id: flightId }, data: { status: client_1.FlightStatus.COMPLETED } });
            const detail = await manifests();
            const manifest = detail.manifests[0];
            await strict_1.default.rejects(call("saveDraft", manifest.id, { operationId: (0, node_crypto_1.randomUUID)(), version: manifest.version, lines: manifest.lines }, legacyReq), (error) => status(error) === 403);
            await strict_1.default.rejects(call("reportDetails", flightId, otherLeadReq), (error) => status(error) === 403);
        });
        await t.test("rejects concurrent draft overwrites and locks loaded quantities from first save", async () => {
            const detail = await manifests();
            const manifest = detail.manifests[0];
            const payload = (consumed) => ({ operationId: (0, node_crypto_1.randomUUID)(), version: manifest.version, lines: manifest.lines.map((line) => ({ ...line, consumed, returned: line.loaded - consumed, spoiled: 0, discarded: 0 })) });
            const inputs = [payload(1), payload(2)];
            const race = await Promise.allSettled(inputs.map((input) => call("saveDraft", manifest.id, input, purserReq)));
            strict_1.default.equal(race.filter((result) => result.status === "fulfilled").length, 1);
            for (const result of race)
                if (result.status === "rejected")
                    strict_1.default.equal(status(result.reason), 409);
            const accepted = inputs[race.findIndex((result) => result.status === "fulfilled")];
            const retry = await call("saveDraft", manifest.id, accepted, purserReq);
            strict_1.default.equal(typeof retry.version, "number");
            await strict_1.default.rejects(call("saveDraft", manifest.id, { ...accepted, lines: accepted.lines.map((line) => ({ ...line, remarks: "Changed retry" })) }, purserReq), (error) => status(error) === 409);
            const fresh = await manifests();
            for (const current of fresh.manifests)
                await call("saveDraft", current.id, { operationId: (0, node_crypto_1.randomUUID)(), version: current.version, lines: current.lines.map((line) => ({ ...line, consumed: line.loaded - 1, returned: 0, spoiled: 0, discarded: 1 })) }, purserReq);
            strict_1.default.ok((await db.flight.findUniqueOrThrow({ where: { id: flightId } })).reportingStartedAt);
            const updated = (await manifests()).manifests[0];
            await strict_1.default.rejects(call("saveLeadLoad", updated.id, { operationId: (0, node_crypto_1.randomUUID)(), version: updated.version, lines: updated.lines.map((line) => ({ id: line.id, approved: line.loaded + 1, loaded: line.loaded + 1, overrideReason: "Changed after reporting" })) }, leadReq), (error) => status(error) === 409);
        });
        await t.test("requires review confirmation and snapshots all sectors and cabins", async () => {
            const detail = await manifests();
            const payload = { operationId: (0, node_crypto_1.randomUUID)(), manifestVersions: Object.fromEntries(detail.manifests.map((manifest) => [manifest.id, manifest.version])), confirmed: true, notes: "Flight-level variance explanation" };
            await strict_1.default.rejects(call("submitReport", flightId, { ...payload, operationId: (0, node_crypto_1.randomUUID)(), confirmed: false }, purserReq), (error) => status(error) === 400);
            await strict_1.default.rejects(call("submitReport", flightId, { ...payload, operationId: (0, node_crypto_1.randomUUID)(), notes: "" }, purserReq), (error) => status(error) === 400);
            const report = await call("submitReport", flightId, payload, purserReq);
            reportId = report.id;
            reportVersion = report.version || 1;
            const snapshot = await call("reportDetails", flightId, purserReq);
            strict_1.default.equal(snapshot.lines.length, 4);
            strict_1.default.equal(snapshot.purser.name, "Mugisha Éric");
            strict_1.default.equal(snapshot.notes, payload.notes);
            firstSnapshot = (await db.reportRevision.findUniqueOrThrow({ where: { reportId_revision: { reportId, revision: 1 } } })).snapshot;
            strict_1.default.equal(await db.crewSubmission.count({ where: { flightId } }), 0);
            const progress = await call("leadCrewStatus", flightId, leadReq);
            strict_1.default.equal(progress.submitted, 1);
            strict_1.default.equal(progress.allReported, true);
            await db.user.update({ where: { id: accounts[2].id }, data: { name: "Renamed after submission" } });
            await db.catalogItem.update({ where: { id: meal.id }, data: { nameEn: "Renamed meal" } });
            const preserved = await call("reportDetails", flightId, purserReq);
            strict_1.default.equal(preserved.purser.name, "Mugisha Éric");
            strict_1.default.equal(preserved.lines.find((line) => line.sku === mealSku)?.item, "Repas végétarien");
        });
        await t.test("returned reports use saved corrections and preserve the earlier revision", async () => {
            await call("decide", reportId, { operationId: (0, node_crypto_1.randomUUID)(), version: reportVersion, decision: "RETURNED", reason: "Please recount" }, leadReq);
            strict_1.default.deepEqual((await db.reportRevision.findUniqueOrThrow({ where: { reportId_revision: { reportId, revision: 1 } } })).snapshot, firstSnapshot);
            const flight = await db.flight.findUniqueOrThrow({ where: { id: flightId } });
            await strict_1.default.rejects(call("assignFlightCrew", flightId, { operationId: (0, node_crypto_1.randomUUID)(), version: flight.version, assignments: [{ userId: accounts[3].id, duty: "PURSER" }] }, leadReq), (error) => status(error) === 409);
            const detail = await manifests();
            for (const manifest of detail.manifests)
                await call("saveDraft", manifest.id, { operationId: (0, node_crypto_1.randomUUID)(), version: manifest.version, lines: manifest.lines.map((line) => ({ ...line, consumed: 0, returned: line.loaded, spoiled: 0, discarded: 0, remarks: "Corrected count" })) }, purserReq);
            const corrected = await call("reportDetails", flightId, purserReq);
            strict_1.default.ok(corrected.lines.every((line) => line.consumed === 0 && line.remarks === "Corrected count"));
            const fresh = await manifests();
            const report = await call("submitReport", flightId, { operationId: (0, node_crypto_1.randomUUID)(), confirmed: true, manifestVersions: Object.fromEntries(fresh.manifests.map((manifest) => [manifest.id, manifest.version])), notes: "Corrected report" }, purserReq);
            reportVersion = report.version;
            strict_1.default.equal(reportVersion, 2);
            const historic = await call("reportDetails", flightId, purserReq, "1");
            strict_1.default.equal(historic.purser.name, "Mugisha Éric");
            strict_1.default.ok(historic.lines.some((line) => line.consumed > 0));
        });
        await t.test("posts the ledger once across concurrent approvals and validates retry payloads", async () => {
            await call("decide", reportId, { operationId: (0, node_crypto_1.randomUUID)(), version: reportVersion, decision: "FORWARDED" }, leadReq);
            const operations = [(0, node_crypto_1.randomUUID)(), (0, node_crypto_1.randomUUID)()];
            const results = await Promise.allSettled(operations.map((operationId) => call("decide", reportId, { operationId, version: reportVersion, decision: "APPROVED" }, cateringReq)));
            strict_1.default.equal(results.filter((result) => result.status === "fulfilled").length, 1);
            const count = await db.stockMovement.count({ where: { flightId } });
            strict_1.default.equal(count, 4, "four informational returns must each be posted once");
            const winner = results.findIndex((result) => result.status === "fulfilled");
            await call("decide", reportId, { operationId: operations[winner], version: reportVersion, decision: "APPROVED" }, cateringReq);
            strict_1.default.equal(await db.stockMovement.count({ where: { flightId } }), count);
            await strict_1.default.rejects(call("decide", reportId, { operationId: operations[winner], version: reportVersion, decision: "RETURNED", reason: "Mismatched retry" }, cateringReq), (error) => status(error) === 409);
            strict_1.default.equal(await db.approval.count({ where: { reportId, decision: "APPROVED" } }), 1);
            strict_1.default.deepEqual((await db.reportRevision.findUniqueOrThrow({ where: { reportId_revision: { reportId, revision: 1 } } })).snapshot, firstSnapshot);
        });
        await t.test("both report downloads include all lines, explanations and review history", async () => {
            const headers = {};
            const response = { setHeader: (key, value) => { headers[key] = value; } };
            const csv = await call("reportCsv", flightId, cateringReq, response);
            strict_1.default.match(csv, /Corrected report/);
            strict_1.default.match(csv, /APPROVED/);
            strict_1.default.match(csv, /Cabin Services reviewer/);
            strict_1.default.match(csv, /Corrected count/);
            const output = await call("reportPdf", flightId, cateringReq, response);
            strict_1.default.ok(output instanceof common_1.StreamableFile);
            const chunks = [];
            for await (const chunk of output.getStream())
                chunks.push(Buffer.from(chunk));
            strict_1.default.equal(Buffer.concat(chunks).subarray(0, 5).toString(), "%PDF-");
            strict_1.default.equal(headers["Content-Type"], "application/pdf");
        });
    }
    finally {
        await db.$disconnect();
    }
});
(0, node_test_1.default)("the documented download templates use a shared fixture", () => {
    const flights = (0, node_fs_1.readFileSync)((0, node_path_1.resolve)(process.cwd(), "../../docs/flights-template.csv"), "utf8");
    const catering = (0, node_fs_1.readFileSync)((0, node_path_1.resolve)(process.cwd(), "../../docs/catering-template.csv"), "utf8");
    strict_1.default.match(flights, /WB700,2026-11-04/);
    strict_1.default.match(catering, /WB700,2026-11-04/);
    strict_1.default.ok(client_1.Cabin.ECONOMY);
});
