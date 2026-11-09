ALTER TABLE "CateringList" ADD COLUMN "leadId" TEXT;
ALTER TABLE "CateringList" ADD COLUMN "purserId" TEXT;
ALTER TABLE "CateringList" ADD COLUMN "reportingStartedAt" TIMESTAMP(3);

ALTER TABLE "CateringListLine" ADD COLUMN "consumed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CateringListLine" ADD COLUMN "returned" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CateringListLine" ADD COLUMN "spoiled" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CateringListLine" ADD COLUMN "discarded" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CateringListLine" ADD COLUMN "remarks" TEXT;
ALTER TABLE "StockMovement" ADD COLUMN "runId" TEXT;

CREATE TABLE "CateringRunReport" (
    "id" TEXT NOT NULL,
    "cateringListId" TEXT NOT NULL,
    "purserId" TEXT NOT NULL,
    "purserName" TEXT NOT NULL,
    "notes" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    CONSTRAINT "CateringRunReport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CateringRunReportLine" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "cateringListLineId" TEXT,
    "itemId" TEXT NOT NULL,
    "itemSku" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "sectorSequence" INTEGER NOT NULL,
    "cabin" "Cabin" NOT NULL,
    "loaded" INTEGER NOT NULL,
    "consumed" INTEGER NOT NULL,
    "returned" INTEGER NOT NULL,
    "spoiled" INTEGER NOT NULL,
    "discarded" INTEGER NOT NULL,
    "unexplained" INTEGER NOT NULL,
    "remarks" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "CateringRunReportLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CateringRunReportRevision" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CateringRunReportRevision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CateringRunApproval" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "decision" "ReportStatus" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorName" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "CateringRunApproval_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CateringRunReport_cateringListId_key" ON "CateringRunReport"("cateringListId");
CREATE UNIQUE INDEX "CateringRunReportLine_reportId_cateringListLineId_revision_key" ON "CateringRunReportLine"("reportId", "cateringListLineId", "revision");
CREATE INDEX "CateringRunReportLine_reportId_revision_idx" ON "CateringRunReportLine"("reportId", "revision");
CREATE UNIQUE INDEX "CateringRunReportRevision_reportId_revision_key" ON "CateringRunReportRevision"("reportId", "revision");
CREATE INDEX "CateringRunReportRevision_reportId_createdAt_idx" ON "CateringRunReportRevision"("reportId", "createdAt");
CREATE INDEX "StockMovement_runId_idx" ON "StockMovement"("runId");

ALTER TABLE "CateringList" ADD CONSTRAINT "CateringList_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CateringList" ADD CONSTRAINT "CateringList_purserId_fkey" FOREIGN KEY ("purserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CateringRunReport" ADD CONSTRAINT "CateringRunReport_cateringListId_fkey" FOREIGN KEY ("cateringListId") REFERENCES "CateringList"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CateringRunReport" ADD CONSTRAINT "CateringRunReport_purserId_fkey" FOREIGN KEY ("purserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CateringRunReportLine" ADD CONSTRAINT "CateringRunReportLine_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "CateringRunReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CateringRunReportLine" ADD CONSTRAINT "CateringRunReportLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "CatalogItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CateringRunReportRevision" ADD CONSTRAINT "CateringRunReportRevision_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "CateringRunReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CateringRunApproval" ADD CONSTRAINT "CateringRunApproval_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "CateringRunReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CateringRunApproval" ADD CONSTRAINT "CateringRunApproval_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CateringList"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Preserve historical operational records that never had an imported CateringList.
-- A report or manifest is enough evidence to create a legacy run shell; the
-- original Flight remains linked through the existing cateringListId relation.
INSERT INTO "CateringList" ("id", "name", "flightNumber", "serviceDate", "status", "createdById", "createdAt", "updatedAt")
SELECT md5('catering-legacy-run:' || f."id"),
       f."flightNumber" || ' · ' || to_char(f."serviceDate", 'YYYY-MM-DD') || ' · legacy',
       f."flightNumber",
       f."serviceDate",
       'READY',
       COALESCE(r."purserId", ca."userId", f."leadId", (SELECT u."id" FROM "User" u ORDER BY u."createdAt" LIMIT 1)),
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
FROM "Flight" f
LEFT JOIN "FlightReport" r ON r."flightId" = f."id"
LEFT JOIN LATERAL (
  SELECT "userId" FROM "CrewAssignment"
  WHERE "flightId" = f."id" AND "duty" = 'PURSER'
  ORDER BY "id"
  LIMIT 1
) ca ON TRUE
WHERE f."cateringListId" IS NULL
  AND (r."id" IS NOT NULL OR EXISTS (SELECT 1 FROM "Manifest" m WHERE m."flightId" = f."id"))
  AND NOT EXISTS (
    SELECT 1 FROM "CateringList" existing
    WHERE existing."flightNumber" = f."flightNumber"
      AND existing."serviceDate" = f."serviceDate"
  );

UPDATE "Flight" f
SET "cateringListId" = cl."id"
FROM "CateringList" cl
WHERE f."cateringListId" IS NULL
  AND cl."flightNumber" = f."flightNumber"
  AND cl."serviceDate" = f."serviceDate";

UPDATE "StockMovement" sm
SET "runId" = f."cateringListId"
FROM "Flight" f
WHERE sm."flightId" = f."id"
  AND f."cateringListId" IS NOT NULL
  AND sm."runId" IS NULL;

-- Materialize legacy manifest lines into the run so draft quantities remain
-- available after the run-centric API stops reading Manifest directly.
INSERT INTO "CateringListLine" ("id", "cateringListId", "sectorSequence", "cabin", "itemId", "suggested", "planned", "approved", "loaded", "consumed", "returned", "spoiled", "discarded", "remarks", "overrideReason")
SELECT md5('catering-legacy-line:' || ml."id"),
       f."cateringListId",
       s."sequence",
       m."cabin",
       ml."itemId",
       ml."suggested",
       ml."planned",
       ml."approved",
       ml."loaded",
       ml."consumed",
       ml."returned",
       ml."spoiled",
       ml."discarded",
       ml."remarks",
       ml."overrideReason"
FROM "ManifestLine" ml
JOIN "Manifest" m ON m."id" = ml."manifestId"
JOIN "Sector" s ON s."id" = m."sectorId"
JOIN "Flight" f ON f."id" = m."flightId"
WHERE f."cateringListId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "CateringListLine" cll
    WHERE cll."cateringListId" = f."cateringListId"
      AND cll."sectorSequence" = s."sequence"
      AND cll."cabin" = m."cabin"
      AND cll."itemId" = ml."itemId"
  );

-- Imported lines are authoritative for the load plan; the latest manifest
-- draft remains authoritative for in-progress leftovers quantities.
UPDATE "CateringListLine" cll
SET "loaded" = ml."loaded",
    "consumed" = ml."consumed",
    "returned" = ml."returned",
    "spoiled" = ml."spoiled",
    "discarded" = ml."discarded",
    "remarks" = ml."remarks",
    "suggested" = ml."suggested",
    "planned" = ml."planned",
    "approved" = ml."approved",
    "overrideReason" = ml."overrideReason"
FROM "ManifestLine" ml
JOIN "Manifest" m ON m."id" = ml."manifestId"
JOIN "Sector" s ON s."id" = m."sectorId"
JOIN "Flight" f ON f."id" = m."flightId"
WHERE cll."cateringListId" = f."cateringListId"
  AND cll."sectorSequence" = s."sequence"
  AND cll."cabin" = m."cabin"
  AND cll."itemId" = ml."itemId";

UPDATE "CateringList" cl
SET "leadId" = f."leadId",
    "reportingStartedAt" = f."reportingStartedAt"
FROM "Flight" f
WHERE f."cateringListId" = cl."id";

UPDATE "CateringList" cl
SET "purserId" = COALESCE(ca."userId", r."purserId")
FROM "Flight" f
LEFT JOIN "CrewAssignment" ca ON ca."flightId" = f."id" AND ca."duty" = 'PURSER'
LEFT JOIN "FlightReport" r ON r."flightId" = f."id"
WHERE f."cateringListId" = cl."id";

INSERT INTO "CateringRunReport" ("id", "cateringListId", "purserId", "purserName", "notes", "status", "version", "submittedAt", "approvedAt")
SELECT md5('catering-run-report:' || r."id"),
       f."cateringListId",
       r."purserId",
       r."purserName",
       r."notes",
       r."status",
       r."version",
       r."submittedAt",
       r."approvedAt"
FROM "FlightReport" r
JOIN "Flight" f ON f."id" = r."flightId"
WHERE f."cateringListId" IS NOT NULL;

INSERT INTO "CateringRunReportLine" ("id", "reportId", "cateringListLineId", "itemId", "itemSku", "itemName", "unit", "sectorSequence", "cabin", "loaded", "consumed", "returned", "spoiled", "discarded", "unexplained", "remarks", "revision")
SELECT md5('catering-run-report-line:' || rl."id"),
       md5('catering-run-report:' || r."id"),
       cll."id",
       ml."itemId",
       ci."sku",
       ci."nameEn",
       ci."unit",
       s."sequence",
       m."cabin",
       ml."loaded",
       rl."consumed",
       rl."returned",
       rl."spoiled",
       rl."discarded",
       rl."unexplained",
       rl."remarks",
       rl."revision"
FROM "ReportLine" rl
JOIN "FlightReport" r ON r."id" = rl."reportId"
JOIN "Flight" f ON f."id" = r."flightId"
JOIN "ManifestLine" ml ON ml."id" = rl."manifestLineId"
JOIN "Manifest" m ON m."id" = ml."manifestId"
JOIN "Sector" s ON s."id" = m."sectorId"
JOIN "CatalogItem" ci ON ci."id" = ml."itemId"
LEFT JOIN "CateringListLine" cll ON cll."cateringListId" = f."cateringListId"
  AND cll."sectorSequence" = s."sequence"
  AND cll."cabin" = m."cabin"
  AND cll."itemId" = ml."itemId"
WHERE f."cateringListId" IS NOT NULL;

INSERT INTO "CateringRunReportRevision" ("id", "reportId", "revision", "snapshot", "createdAt")
SELECT md5('catering-run-report-revision:' || rr."id"),
       md5('catering-run-report:' || r."id"),
       rr."revision",
       rr."snapshot",
       rr."createdAt"
FROM "ReportRevision" rr
JOIN "FlightReport" r ON r."id" = rr."reportId"
JOIN "Flight" f ON f."id" = r."flightId"
WHERE f."cateringListId" IS NOT NULL;

INSERT INTO "CateringRunApproval" ("id", "reportId", "actorId", "decision", "reason", "createdAt", "actorName", "revision")
SELECT md5('catering-run-approval:' || a."id"),
       md5('catering-run-report:' || r."id"),
       a."actorId",
       a."decision",
       a."reason",
       a."createdAt",
       a."actorName",
       a."revision"
FROM "Approval" a
JOIN "FlightReport" r ON r."id" = a."reportId"
JOIN "Flight" f ON f."id" = r."flightId"
WHERE f."cateringListId" IS NOT NULL;
