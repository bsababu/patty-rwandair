import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { PrismaClient, Role, Cabin, FlightStatus } from "@prisma/client";
import { hash } from "argon2";
import { StreamableFile } from "@nestjs/common";

const testUrl = process.env.TEST_DATABASE_URL;
const status = (error: unknown) => typeof error === "object" && error !== null && "getStatus" in error
  ? (error as { getStatus(): number }).getStatus() : 0;

test("real PostgreSQL: imports, purser reports, corrections and once-only stock approval", { skip: !testUrl }, async (t) => {
  assert.match(new URL(testUrl!).pathname, /test|verification/i, "TEST_DATABASE_URL must identify an isolated test database");
  process.env.DATABASE_URL = testUrl;
  const db = new PrismaClient({ datasourceUrl: testUrl });
  const { AppController } = await import("./app");
  const controller = new AppController();
  const call = <T = Record<string, unknown>>(method: string, ...args: unknown[]) =>
    (controller as unknown as Record<string, (...params: unknown[]) => Promise<T>>)[method](...args);
  const prefix = randomUUID().slice(0, 8);
  const passwordHash = await hash("Integration-only-password-2026");
  const accounts = await Promise.all([
    { role: Role.PROCUREMENT, name: "Catering reviewer" },
    { role: Role.LEAD, name: "Cabin Services reviewer" },
    { role: Role.ATTENDANT, name: "Mugisha Éric" },
    { role: Role.ATTENDANT, name: "Legacy cabin crew" },
    { role: Role.LEAD, name: "Unassigned lead" },
  ].map((account, index) => db.user.create({ data: { ...account, email: `${prefix}-${index}@integration.test`, passwordHash } })));
  const requests = await Promise.all(accounts.map(async (account) => {
    const csrfToken = randomUUID();
    const session = await db.session.create({ data: { id: randomUUID(), userId: account.id, csrfToken, expiresAt: new Date(Date.now() + 3_600_000) } });
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
  let firstSnapshot: unknown;
  type Preview = { id: string; errorCount: number; rows: Array<{ errors: string[] }> };
  type Detail = { id: string; version: number; manifests: Array<{ id: string; version: number; lines: Array<{ id: string; loaded: number; consumed: number; returned: number; spoiled: number; discarded: number }> }> };
  const manifests = () => call<Detail>("manifest", flightId, purserReq);
  try {
    await t.test("refreshes missing-flight errors after a valid overnight flight import", async () => {
      const before = await call<Preview>("previewImport", { type: "CATERING", fileName: "catering.csv", csv: cateringCsv }, cateringReq);
      firstPreviewId = before.id;
      assert.equal(before.errorCount, 4);
      assert.equal(before.rows.some((row) => row.errors.some((error) => error.includes("Duplicate"))), false);
      const flightPreview = await call<Preview>("previewImport", { type: "FLIGHTS", fileName: "flights.csv", csv: flightCsv }, cateringReq);
      assert.equal(flightPreview.errorCount, 0, JSON.stringify(flightPreview.rows));
      const result = await call<{ ids: string[] }>("commitImport", flightPreview.id, cateringReq);
      flightId = result.ids[0];
      const flight = await db.flight.findUniqueOrThrow({ where: { id: flightId } });
      assert.equal(flight.serviceDate.toISOString().slice(0, 10), "2026-11-04");
      assert.equal(flight.flightDate.toISOString().slice(0, 10), "2026-11-03");
      const refreshed = await call<Preview>("previewImport", { type: "CATERING", fileName: "catering.csv", csv: cateringCsv }, cateringReq);
      assert.equal(refreshed.id, firstPreviewId);
      assert.equal(refreshed.errorCount, 0, JSON.stringify(refreshed.rows));
      await call("commitImport", refreshed.id, cateringReq);
      const list = await db.cateringList.findUniqueOrThrow({ where: { flightNumber_serviceDate: { flightNumber: flight.flightNumber, serviceDate: flight.serviceDate } } });
      await db.flight.update({ where: { id: flightId }, data: { leadId: accounts[1].id } });
      await call("attachCateringList", flightId, list.id, { operationId: randomUUID() }, leadReq);
    });

    await t.test("enforces one purser and keeps legacy crew read-only after completion", async () => {
      const flight = await db.flight.findUniqueOrThrow({ where: { id: flightId } });
      await assert.rejects(call("assignFlightCrew", flightId, { version: flight.version, assignments: [{ userId: accounts[2].id, duty: "PURSER" }, { userId: accounts[3].id, duty: "CABIN_CREW" }] }, leadReq), (error) => status(error) === 400);
      await call("assignFlightCrew", flightId, { operationId: randomUUID(), version: flight.version, assignments: [{ userId: accounts[2].id, duty: "PURSER" }] }, leadReq);
      await db.crewAssignment.create({ data: { flightId, userId: accounts[3].id, duty: "CABIN_CREW" } });
      await db.flight.update({ where: { id: flightId }, data: { status: FlightStatus.COMPLETED } });
      const detail = await manifests();
      const manifest = detail.manifests[0];
      await assert.rejects(call("saveDraft", manifest.id, { operationId: randomUUID(), version: manifest.version, lines: manifest.lines }, legacyReq), (error) => status(error) === 403);
      await assert.rejects(call("reportDetails", flightId, otherLeadReq), (error) => status(error) === 403);
    });

    await t.test("rejects concurrent draft overwrites and locks loaded quantities from first save", async () => {
      const detail = await manifests();
      const manifest = detail.manifests[0];
      const payload = (consumed: number) => ({ operationId: randomUUID(), version: manifest.version, lines: manifest.lines.map((line) => ({ ...line, consumed, returned: line.loaded - consumed, spoiled: 0, discarded: 0 })) });
      const inputs = [payload(1), payload(2)];
      const race = await Promise.allSettled(inputs.map((input) => call("saveDraft", manifest.id, input, purserReq)));
      assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
      for (const result of race) if (result.status === "rejected") assert.equal(status(result.reason), 409);
      const accepted = inputs[race.findIndex((result) => result.status === "fulfilled")];
      const retry = await call<{ version: number }>("saveDraft", manifest.id, accepted, purserReq);
      assert.equal(typeof retry.version, "number");
      await assert.rejects(call("saveDraft", manifest.id, { ...accepted, lines: accepted.lines.map((line) => ({ ...line, remarks: "Changed retry" })) }, purserReq), (error) => status(error) === 409);
      const fresh = await manifests();
      for (const current of fresh.manifests) await call("saveDraft", current.id, { operationId: randomUUID(), version: current.version, lines: current.lines.map((line) => ({ ...line, consumed: line.loaded - 1, returned: 0, spoiled: 0, discarded: 1 })) }, purserReq);
      assert.ok((await db.flight.findUniqueOrThrow({ where: { id: flightId } })).reportingStartedAt);
      const updated = (await manifests()).manifests[0];
      await assert.rejects(call("saveLeadLoad", updated.id, { operationId: randomUUID(), version: updated.version, lines: updated.lines.map((line) => ({ id: line.id, approved: line.loaded + 1, loaded: line.loaded + 1, overrideReason: "Changed after reporting" })) }, leadReq), (error) => status(error) === 409);
    });

    await t.test("requires review confirmation and snapshots all sectors and cabins", async () => {
      const detail = await manifests();
      const payload = { operationId: randomUUID(), manifestVersions: Object.fromEntries(detail.manifests.map((manifest) => [manifest.id, manifest.version])), confirmed: true, notes: "Flight-level variance explanation" };
      await assert.rejects(call("submitReport", flightId, { ...payload, operationId: randomUUID(), confirmed: false }, purserReq), (error) => status(error) === 400);
      await assert.rejects(call("submitReport", flightId, { ...payload, operationId: randomUUID(), notes: "" }, purserReq), (error) => status(error) === 400);
      const report = await call<{ id: string; version: number }>("submitReport", flightId, payload, purserReq);
      reportId = report.id;
      reportVersion = report.version || 1;
      const snapshot = await call<{ lines: unknown[]; purser: { name: string }; notes: string }>("reportDetails", flightId, purserReq);
      assert.equal(snapshot.lines.length, 4);
      assert.equal(snapshot.purser.name, "Mugisha Éric");
      assert.equal(snapshot.notes, payload.notes);
      firstSnapshot = (await db.reportRevision.findUniqueOrThrow({ where: { reportId_revision: { reportId, revision: 1 } } })).snapshot;
      assert.equal(await db.crewSubmission.count({ where: { flightId } }), 0);
      const progress = await call<{ submitted: number; allReported: boolean }>("leadCrewStatus", flightId, leadReq);
      assert.equal(progress.submitted, 1);
      assert.equal(progress.allReported, true);
      await db.user.update({ where: { id: accounts[2].id }, data: { name: "Renamed after submission" } });
      await db.catalogItem.update({ where: { id: meal.id }, data: { nameEn: "Renamed meal" } });
      const preserved = await call<{ purser: { name: string }; lines: Array<{ sku: string; item: string }> }>("reportDetails", flightId, purserReq);
      assert.equal(preserved.purser.name, "Mugisha Éric");
      assert.equal(preserved.lines.find((line) => line.sku === mealSku)?.item, "Repas végétarien");
    });

    await t.test("returned reports use saved corrections and preserve the earlier revision", async () => {
      await call("decide", reportId, { operationId: randomUUID(), version: reportVersion, decision: "RETURNED", reason: "Please recount" }, leadReq);
      assert.deepEqual((await db.reportRevision.findUniqueOrThrow({ where: { reportId_revision: { reportId, revision: 1 } } })).snapshot, firstSnapshot);
      const flight = await db.flight.findUniqueOrThrow({ where: { id: flightId } });
      await assert.rejects(call("assignFlightCrew", flightId, { operationId: randomUUID(), version: flight.version, assignments: [{ userId: accounts[3].id, duty: "PURSER" }] }, leadReq), (error) => status(error) === 409);
      const detail = await manifests();
      for (const manifest of detail.manifests) await call("saveDraft", manifest.id, { operationId: randomUUID(), version: manifest.version, lines: manifest.lines.map((line) => ({ ...line, consumed: 0, returned: line.loaded, spoiled: 0, discarded: 0, remarks: "Corrected count" })) }, purserReq);
      const corrected = await call<{ lines: Array<{ consumed: number; remarks: string }> }>("reportDetails", flightId, purserReq);
      assert.ok(corrected.lines.every((line) => line.consumed === 0 && line.remarks === "Corrected count"));
      const fresh = await manifests();
      const report = await call<{ version: number }>("submitReport", flightId, { operationId: randomUUID(), confirmed: true, manifestVersions: Object.fromEntries(fresh.manifests.map((manifest) => [manifest.id, manifest.version])), notes: "Corrected report" }, purserReq);
      reportVersion = report.version;
      assert.equal(reportVersion, 2);
      const historic = await call<{ purser: { name: string }; lines: Array<{ consumed: number }> }>("reportDetails", flightId, purserReq, "1");
      assert.equal(historic.purser.name, "Mugisha Éric");
      assert.ok(historic.lines.some((line) => line.consumed > 0));
    });

    await t.test("posts the ledger once across concurrent approvals and validates retry payloads", async () => {
      await call("decide", reportId, { operationId: randomUUID(), version: reportVersion, decision: "FORWARDED" }, leadReq);
      const operations = [randomUUID(), randomUUID()];
      const results = await Promise.allSettled(operations.map((operationId) => call("decide", reportId, { operationId, version: reportVersion, decision: "APPROVED" }, cateringReq)));
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const count = await db.stockMovement.count({ where: { flightId } });
      assert.equal(count, 4, "four informational returns must each be posted once");
      const winner = results.findIndex((result) => result.status === "fulfilled");
      await call("decide", reportId, { operationId: operations[winner], version: reportVersion, decision: "APPROVED" }, cateringReq);
      assert.equal(await db.stockMovement.count({ where: { flightId } }), count);
      await assert.rejects(call("decide", reportId, { operationId: operations[winner], version: reportVersion, decision: "RETURNED", reason: "Mismatched retry" }, cateringReq), (error) => status(error) === 409);
      assert.equal(await db.approval.count({ where: { reportId, decision: "APPROVED" } }), 1);
      assert.deepEqual((await db.reportRevision.findUniqueOrThrow({ where: { reportId_revision: { reportId, revision: 1 } } })).snapshot, firstSnapshot);
    });

    await t.test("both report downloads include all lines, explanations and review history", async () => {
      const headers: Record<string, string> = {};
      const response = { setHeader: (key: string, value: string) => { headers[key] = value; } };
      const csv = await call<string>("reportCsv", flightId, cateringReq, response);
      assert.match(csv, /Corrected report/);
      assert.match(csv, /APPROVED/);
      assert.match(csv, /Cabin Services reviewer/);
      assert.match(csv, /Corrected count/);
      const output = await call<StreamableFile>("reportPdf", flightId, cateringReq, response);
      assert.ok(output instanceof StreamableFile);
      const chunks: Buffer[] = [];
      for await (const chunk of output.getStream()) chunks.push(Buffer.from(chunk));
      assert.equal(Buffer.concat(chunks).subarray(0, 5).toString(), "%PDF-");
      assert.equal(headers["Content-Type"], "application/pdf");
    });
  } finally {
    await db.$disconnect();
  }
});

test("the documented download templates use a shared fixture", () => {
  const flights = readFileSync(resolve(process.cwd(), "../../docs/flights-template.csv"), "utf8");
  const catering = readFileSync(resolve(process.cwd(), "../../docs/catering-template.csv"), "utf8");
  assert.match(flights, /WB700,2026-11-04/);
  assert.match(catering, /WB700,2026-11-04/);
  assert.ok(Cabin.ECONOMY);
});
