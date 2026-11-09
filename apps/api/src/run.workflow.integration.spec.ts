import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient, Role } from "@prisma/client";
import { hash } from "argon2";
import { cleanupRunFixtures } from "./test-fixtures";

const testUrl = process.env.TEST_DATABASE_URL;
test("run workflow: imports, assigns multiple Pursers, generates and approves without a schedule", { skip: !testUrl }, async (t) => {
  assert.match(new URL(testUrl!).pathname, /test|verification/i, "TEST_DATABASE_URL must identify an isolated test database");
  process.env.DATABASE_URL = testUrl;
  const db = new PrismaClient({ datasourceUrl: testUrl });
  const { AppController } = await import("./app");
  const controller = new AppController();
  const call = <T = Record<string, unknown>>(method: string, ...args: unknown[]) =>
    (controller as unknown as Record<string, (...params: unknown[]) => Promise<T>>)[method](...args);
  const prefix = randomUUID().slice(0, 8);
  const flightDigits = "9101";
  const passwordHash = await hash("Run-only-integration-password-2026");
  const accounts = await Promise.all([
    { role: Role.PROCUREMENT, name: "Run Catering" },
    { role: Role.LEAD, name: "Run Cabin Services" },
    { role: Role.ATTENDANT, name: "Run Flight Purser" },
    { role: Role.ATTENDANT, name: "Run Relief Purser" },
    { role: Role.DIRECTOR, name: "Run Director" },
  ].map((account, index) => db.user.create({ data: { ...account, email: `${prefix}-${index}@run.test`, passwordHash } })));
  const requests = await Promise.all(accounts.map(async (account) => {
    const csrfToken = randomUUID();
    const session = await db.session.create({ data: { id: randomUUID(), userId: account.id, csrfToken, expiresAt: new Date(Date.now() + 3_600_000) } });
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
      const preview = await call<{ id: string; errorCount: number }>("previewImport", { type: "CATERING", fileName: "run.csv", csv }, cateringReq);
      assert.equal(preview.errorCount, 0);
      await call("commitImport", preview.id, cateringReq);
      const runs = await call<Array<{ id: string; flightNumber: string; serviceDate: string; status: string }>>("runs", cateringReq);
      const created = runs.find((run) => run.flightNumber === `WB ${flightDigits}`);
      assert.ok(created);
      assert.equal(new Date(created.serviceDate).toISOString().slice(0, 10), "2026-11-04");
      assert.equal(created.status, "READY");
    });

    const runs = await call<Array<{ id: string; flightNumber: string; version: number; lines: Array<{ id: string; loaded: number; consumed: number; returned: number; spoiled: number; discarded: number }> }>>("runs", cateringReq);
    const run = runs.find((entry) => entry.flightNumber === `WB ${flightDigits}`);
    assert.ok(run);

    await t.test("lead and purser assignments are owned by the run", async () => {
      await call("assignRunLead", run.id, { leadId: accounts[1].id, version: run.version }, cateringReq);
      const leadRun = (await call<typeof runs>("runs", leadReq)).find((entry) => entry.id === run.id)!;
      await call("assignRunPursers", run.id, { purserIds: [accounts[2].id, accounts[3].id], version: leadRun.version }, leadReq);
      const visible = await call<Array<{ id: string; lead?: { id: string }; purser?: { id: string }; pursers?: Array<{ id: string }> }>>("runs", purserReq);
      assert.equal(visible[0].id, run.id);
      assert.equal(visible[0].lead?.id, accounts[1].id);
      assert.deepEqual(visible[0].pursers?.map((entry) => entry.id), [accounts[2].id, accounts[3].id]);
      const reliefRuns = await call<Array<{ id: string; pursers?: Array<{ id: string }> }>>("runs", reliefPurserReq);
      assert.equal(reliefRuns[0].id, run.id);
      const [leadNotice, purserNotice] = await Promise.all([
        db.notification.findFirst({ where: { userId: accounts[1].id, kind: "RUN_ASSIGNED" } }),
        db.notification.findFirst({ where: { userId: accounts[2].id, kind: "PURSER_ASSIGNED" } }),
      ]);
      assert.equal(leadNotice?.actionPath, "operations");
      assert.equal(purserNotice?.actionPath, "my-runs");
    });

    await t.test("shared leftovers and lead-generated report reach Catering approval", async () => {
      const assignedRun = (await call<typeof runs>("runs", purserReq))[0];
      assert.equal(assignedRun.id, run.id);
      const draft = {
        version: assignedRun.version,
        lines: assignedRun.lines.map((line) => ({ id: line.id, consumed: 8, remarks: "Run-only count" })),
      };
      const conflict = (error: unknown) => (error as { getStatus?: () => number }).getStatus?.() === 409;
      await assert.rejects(call("generateRunReport", run.id, { operationId: randomUUID(), runVersion: assignedRun.version }, leadReq), conflict);
      assert.equal(await db.cateringRunReport.count({ where: { cateringListId: run.id } }), 0);
      const zero = await call<{ version: number }>("saveRunDraft", run.id, { ...draft, lines: draft.lines.map((line) => ({ ...line, consumed: 0 })) }, purserReq);
      const zeroPreview = await call<{ runVersion: number; lines: Array<{ returned: number; unexplained: number }> }>("previewRunReport", run.id, leadReq);
      assert.equal(zeroPreview.lines[0].returned, 12);
      assert.equal(zeroPreview.lines[0].unexplained, 0);
      // Two Pursers must not overwrite each other with the same base version.
      const race = await Promise.allSettled([purserReq, reliefPurserReq].map((req) => call("saveRunDraft", run.id, { ...draft, version: zero.version }, req)));
      assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(race.filter((result) => result.status === "rejected" && conflict(result.reason)).length, 1);
      await assert.rejects(call("generateRunReport", run.id, { operationId: randomUUID(), runVersion: zeroPreview.runVersion }, leadReq), conflict);
      const preview = await call<{ id: string | null; status: string; runVersion: number; pursers: Array<{ name: string }>; lines: Array<{ item: string; consumed: number; returned: number }> }>("previewRunReport", run.id, leadReq);
      assert.equal(preview.id, null);
      assert.equal(preview.status, "DRAFT");
      assert.equal(preview.lines[0].consumed, 8);
      assert.equal(preview.lines[0].returned, 4);
      assert.deepEqual(new Set(preview.pursers.map((user) => user.name)), new Set([accounts[2].name, accounts[3].name]));
      // Corrupt/unbalanced data must never become an approved missing-stock charge.
      await db.cateringListLine.update({ where: { id: assignedRun.lines[0].id }, data: { returned: 0 } });
      await assert.rejects(call("generateRunReport", run.id, { operationId: randomUUID(), runVersion: preview.runVersion }, leadReq), conflict);
      await db.cateringListLine.update({ where: { id: assignedRun.lines[0].id }, data: { returned: 4 } });
      const operationId = randomUUID();
      const generated = await call<{ id: string; status: string; version: number }>("generateRunReport", run.id, { operationId, runVersion: preview.runVersion }, leadReq);
      assert.equal(generated.status, "FORWARDED");
      const replay = await call<{ id: string }>("generateRunReport", run.id, { operationId, runVersion: preview.runVersion }, leadReq);
      assert.equal(replay.id, generated.id);
      await assert.rejects(call("generateRunReport", run.id, { operationId, runVersion: preview.runVersion + 1 }, leadReq), conflict);
      const cateringNotice = await db.notification.findFirst({ where: { userId: accounts[0].id, kind: "REPORT_READY" } });
      assert.equal(cateringNotice?.actionPath, "reconciliation");
      await call("decideRunReport", generated.id, { decision: "RETURNED", reason: "Please recount the meals", version: generated.version, operationId: randomUUID() }, cateringReq);
      const returned = await call<{ reviewHistory: Array<{ reason: string }> }>("previewRunReport", run.id, leadReq);
      assert.ok(returned.reviewHistory.some((event) => event.reason === "Please recount the meals"));
      const returnedRun = (await call<Array<{ id: string; report: { returnReason: string } }>>("runs", purserReq)).find((entry) => entry.id === run.id)!;
      assert.equal(returnedRun.report.returnReason, "Please recount the meals");
      assert.equal(await db.notification.count({ where: { userId: accounts[3].id, kind: "REPORT_RETURNED", actionPath: "my-runs" } }), 1);
      const correctedPreview = await call<{ runVersion: number }>("previewRunReport", run.id, leadReq);
      const corrected = await call<{ id: string; version: number }>("generateRunReport", run.id, { operationId: randomUUID(), runVersion: correctedPreview.runVersion }, leadReq);
      assert.equal(corrected.version, 2);
      await db.user.update({ where: { id: accounts[3].id }, data: { name: "Renamed after submission" } });
      const frozen = await call<{ pursers: Array<{ name: string }> }>("runReportDetails", run.id, cateringReq);
      assert.ok(frozen.pursers.some((user) => user.name === accounts[3].name));
      const csvReport = await call<string>("runReportCsv", run.id, cateringReq, { setHeader() {} });
      assert.match(csvReport, /Run Flight Purser/); assert.match(csvReport, /Run Relief Purser/);
      const approvals = await Promise.allSettled([randomUUID(), randomUUID()].map((operationId) => call("decideRunReport", corrected.id, { decision: "APPROVED", version: corrected.version, operationId }, cateringReq)));
      assert.equal(approvals.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(await db.stockMovement.count({ where: { runId: run.id } }), 2);
      const operations = await call<{ approved: number; consumed: number; returned: number }>("operationsDashboard", directorReq);
      assert.ok(operations.approved >= 1);
      assert.ok(operations.consumed >= 8);
      assert.ok(operations.returned >= 4);
      const directorNotice = await db.notification.findFirst({ where: { userId: accounts[4].id, kind: "ANALYTICS_UPDATED" } });
      assert.equal(directorNotice?.actionPath, "executive");
    });

    await t.test("cancelled runs remain read-only and reserve no stock", async () => {
      const cancelled = await db.cateringList.create({ data: {
        name: `Cancelled ${prefix}`, flightNumber: "WB 9103", serviceDate: new Date("2030-01-01"), createdById: accounts[0].id,
        leadId: accounts[1].id, purserId: accounts[2].id, status: "CANCELLED", pursers: { create: { userId: accounts[2].id } },
        lines: { create: { itemId: item.id, sectorSequence: 1, cabin: "ECONOMY", suggested: 5, planned: 5, approved: 5, loaded: 5 } },
      }, include: { lines: true } });
      const conflict = (error: unknown) => (error as { getStatus?: () => number }).getStatus?.() === 409;
      await assert.rejects(call("assignRunLead", cancelled.id, { leadId: accounts[1].id, version: 1 }, cateringReq), conflict);
      await assert.rejects(call("addRunPurser", cancelled.id, { purserId: accounts[3].id, version: 1 }, leadReq), conflict);
      await assert.rejects(call("saveRunDraft", cancelled.id, { version: 1, lines: cancelled.lines.map((line) => ({ id: line.id, consumed: 1 })) }, purserReq), conflict);
      await assert.rejects(call("generateRunReport", cancelled.id, { operationId: randomUUID(), runVersion: 1 }, leadReq), conflict);
      const stock = await call<Array<{ id: string; reserved: number }>>("stock", cateringReq);
      assert.equal(stock.find((entry) => entry.id === item.id)?.reserved, 0);
    });

    await t.test("dashboard totals include more than 250 reports and only current revisions", async () => {
      const before = await call<{ approved: number; loaded: number; consumed: number; returned: number }>("operationsDashboard", directorReq);
      const records = Array.from({ length: 251 }, (_, index) => ({ id: `${prefix}-run-${index}`, name: `${prefix} analytics ${index}`, flightNumber: "WB 9102", serviceDate: new Date(Date.UTC(2030, 0, index + 1)), createdById: accounts[0].id }));
      await db.cateringList.createMany({ data: records });
      await db.cateringRunReport.createMany({ data: records.map((record, index) => ({ id: `${prefix}-report-${index}`, cateringListId: record.id, purserId: accounts[2].id, purserName: accounts[2].name, status: "APPROVED", version: 2, submittedAt: new Date() })) });
      const quantities = { itemId: item.id, itemSku: item.sku, itemName: item.nameEn, unit: item.unit, sectorSequence: 1, cabin: "ECONOMY" as const, loaded: 10, consumed: 6, returned: 4, spoiled: 0, discarded: 0, unexplained: 0 };
      await db.cateringRunReportLine.createMany({ data: records.map((_, index) => ({ ...quantities, reportId: `${prefix}-report-${index}`, revision: 2 })) });
      await db.cateringRunReportLine.create({ data: { ...quantities, loaded: 1000, consumed: 1000, returned: 0, reportId: `${prefix}-report-0`, revision: 1 } });
      const after = await call<typeof before & { recent: unknown[] }>("operationsDashboard", directorReq);
      assert.equal(after.approved, before.approved + 251);
      assert.equal(after.loaded, before.loaded + 2510);
      assert.equal(after.consumed, before.consumed + 1506);
      assert.equal(after.returned, before.returned + 1004);
      assert.equal(after.recent.length, 6);
    });
  } finally {
    try { await cleanupRunFixtures(db, accounts.map((account) => account.id), [item.id]); }
    finally { await db.$disconnect(); }
  }
});
