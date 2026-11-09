import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const testUrl = process.env.TEST_DATABASE_URL;
const migrations = resolve(process.cwd(), "prisma/migrations");
const latest = "20261105090000_flight_service_date_reporting";

function legacySchema() {
  assert.ok(testUrl);
  assert.match(new URL(testUrl).pathname, /test|verification/i);
  const schema = `migration_${randomUUID().replaceAll("-", "")}`;
  const env = { ...process.env, PGOPTIONS: `-c search_path=${schema}` };
  const sql = (query: string) => execFileSync("psql", [testUrl!, "-X", "-v", "ON_ERROR_STOP=1", "-At", "-c", query], { env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  const apply = (name: string) => execFileSync("psql", [testUrl!, "-X", "-v", "ON_ERROR_STOP=1", "-q", "-f", resolve(migrations, name, "migration.sql")], { env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  sql(`CREATE SCHEMA ${schema}`);
  for (const name of readdirSync(migrations).sort().filter((name) => name < latest)) apply(name);
  return { sql, apply, cleanup: () => sql(`DROP SCHEMA ${schema} CASCADE`) };
}

test("migration recovers archived service dates and preserves legacy report revisions", { skip: !testUrl }, (t) => {
  const { sql, apply, cleanup } = legacySchema();
  t.after(cleanup);
  sql(`
    INSERT INTO "User" (id,email,"passwordHash",name,role) VALUES ('u1','migration@verification.test','not-a-login','Current staff name','ATTENDANT');
    INSERT INTO "Flight" (id,"flightNumber","flightDate",aircraft,status) VALUES ('f1','WB 435','2026-09-05 06:00:00','A330','COMPLETED');
    INSERT INTO "Flight" (id,"flightNumber","flightDate",aircraft,status) VALUES ('cancelled','WB 436','2026-09-05 10:00:00','A330','CANCELLED');
    INSERT INTO "CrewAssignment" (id,"flightId","userId",duty) VALUES ('cancelled-crew','cancelled','u1','PURSER');
    INSERT INTO "Sector" (id,"flightId",sequence,origin,destination,"scheduledDeparture","scheduledArrival","economyPax","businessPax") VALUES ('s1','f1',1,'KGL','NBO','2026-09-05 06:00:00','2026-09-05 08:00:00',100,10);
    INSERT INTO "CatalogItem" (id,sku,"nameEn","nameFr",category,unit) VALUES ('i1','MEAL-MIGRATION','Meal','Repas','Meal','meal');
    INSERT INTO "Sector" (id,"flightId",sequence,origin,destination,"scheduledDeparture","scheduledArrival","economyPax","businessPax") VALUES ('cancelled-sector','cancelled',1,'KGL','NBO','2026-09-05 10:00:00','2026-09-05 12:00:00',100,10);
    INSERT INTO "Manifest" (id,"flightId","sectorId",cabin) VALUES ('cancelled-manifest','cancelled','cancelled-sector','ECONOMY');
    INSERT INTO "ManifestLine" (id,"manifestId","itemId",suggested,planned,approved,loaded) VALUES ('cancelled-line','cancelled-manifest','i1',5,5,5,5);
    INSERT INTO "Manifest" (id,"flightId","sectorId",cabin) VALUES ('m1','f1','s1','ECONOMY');
    INSERT INTO "ManifestLine" (id,"manifestId","itemId",suggested,planned,approved,loaded,consumed,returned) VALUES ('l1','m1','i1',10,10,10,10,7,3);
    INSERT INTO "FlightReport" (id,"flightId","purserId","purserName",status,version,"submittedAt") VALUES ('r1','f1','u1','Name at submission','RETURNED',2,'2026-11-04 09:00:00');
    INSERT INTO "ReportLine" (id,"reportId","manifestLineId",consumed,returned,spoiled,discarded,unexplained,revision) VALUES ('rl1','r1','l1',8,2,0,0,0,1),('rl2','r1','l1',7,3,0,0,0,2);
    INSERT INTO "Approval" (id,"reportId","actorId",decision,reason) VALUES ('a1','r1','u1','RETURNED','Recount');
    INSERT INTO "ImportBatch" (id,type,status,"fileName",checksum,"sourceText",rows,"rowCount","errorCount","actorId",result)
    VALUES ('b1','FLIGHTS','COMMITTED','legacy.csv','fixture','archived source',
      '[{"row":2,"data":{"flight_number":"WB 435","flight_date":"2026-11-04","sector_sequence":"1","departure_iso":"2026-09-05T08:00:00+02:00"},"errors":[]}]',1,0,'u1','{"ids":["f1"]}');
  `);
  apply(latest);
  assert.equal(sql(`SELECT "serviceDate"::text FROM "Flight" WHERE id='f1'`), "2026-11-04");
  assert.equal(sql(`SELECT "flightDate"::text FROM "Flight" WHERE id='f1'`), "2026-09-05 06:00:00");
  assert.equal(sql(`SELECT "scheduleIssue" IS NOT NULL AND "reportingStartedAt" IS NOT NULL FROM "Flight" WHERE id='f1'`), "t");
  assert.equal(sql(`SELECT COUNT(*) FROM "ReportRevision" WHERE "reportId"='r1'`), "2");
  assert.equal(sql(`SELECT snapshot->'purser'->>'name' FROM "ReportRevision" WHERE "reportId"='r1' AND revision=1`), "Name at submission");
  assert.equal(sql(`SELECT snapshot->'lines'->0->>'consumed' FROM "ReportRevision" WHERE "reportId"='r1' AND revision=1`), "8");
  assert.equal(sql(`SELECT "actorName" FROM "Approval" WHERE id='a1'`), "Current staff name");
  const retained = sql(`SELECT snapshot->'flight'->'sectors'->0->>'scheduledDeparture' FROM "ReportRevision" WHERE "reportId"='r1' AND revision=1`);
  assert.equal(new Date(retained).toISOString(), "2026-09-05T06:00:00.000Z");
  // Exercise every new migration on populated legacy data, not only an empty database.
  for (const name of readdirSync(migrations).sort().filter((name) => /^\d{14}_/.test(name) && name > latest)) apply(name);
  assert.equal(sql(`SELECT c.status FROM "CateringList" c JOIN "Flight" f ON f."cateringListId"=c.id WHERE f.id='cancelled'`), "CANCELLED");
  assert.equal(sql(`SELECT count(*) FROM "CateringListPurser" p JOIN "Flight" f ON f."cateringListId"=p."cateringListId" WHERE f.id='cancelled' AND p."userId"='u1'`), "1");
  assert.equal(sql(`SELECT count(*) FROM "CateringRunReportRevision"`), "2");
  assert.equal(sql(`SELECT snapshot->'purser'->>'name' FROM "CateringRunReportRevision" WHERE revision=1`), "Name at submission");
  assert.equal(sql(`SELECT reason FROM "CateringRunApproval"`), "Recount");
  assert.equal(sql(`SELECT consumed FROM "CateringListLine" c JOIN "Flight" f ON f."cateringListId"=c."cateringListId" WHERE f.id='f1'`), "7");
});

test("migration stops on duplicate canonical flight/date keys instead of merging flights", { skip: !testUrl }, (t) => {
  const { sql, apply, cleanup } = legacySchema();
  t.after(cleanup);
  sql(`INSERT INTO "Flight" (id,"flightNumber","flightDate",aircraft) VALUES ('a','WB 700','2026-11-04 06:00:00','A330'),('b','WB 700','2026-11-04 12:00:00','A330')`);
  assert.throws(() => apply(latest), (error) => error instanceof Error && error.message.includes("duplicate flight/date records"));
  assert.equal(sql(`SELECT COUNT(*) FROM "Flight"`), "2");
  assert.equal(sql(`SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='Flight' AND column_name='serviceDate'`), "0", "a failed migration must roll back all schema/data changes");
});
