BEGIN;

ALTER TABLE "Flight" ADD COLUMN "serviceDate" DATE;
ALTER TABLE "Flight" ADD COLUMN "reportingStartedAt" TIMESTAMP(3);
ALTER TABLE "Flight" ADD COLUMN "scheduleIssue" TEXT;
ALTER TABLE "IdempotencyKey" ADD COLUMN "requestHash" TEXT;
ALTER TABLE "Approval" ADD COLUMN "actorName" TEXT;
ALTER TABLE "Approval" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;

UPDATE "Approval" a SET "actorName" = u."name" FROM "User" u WHERE u."id" = a."actorId";
ALTER TABLE "Approval" ALTER COLUMN "actorName" SET NOT NULL;

UPDATE "Flight"
SET "serviceDate" = "flightDate"::date
WHERE "serviceDate" IS NULL;

-- Import commit results retain the created IDs in first-seen flight-group order.
-- Recover only dates with one unambiguous source; never infer or rewrite schedules.
WITH source_groups AS (
  SELECT b."id" AS batch_id, b."result", r.row->'data'->>'flight_number' AS flight_number,
    r.row->'data'->>'flight_date' AS service_date, MIN(r.ordinality) AS first_row,
    MIN(r.row->'data'->>'departure_iso') FILTER (WHERE r.row->'data'->>'sector_sequence' = '1') AS departure_iso
  FROM "ImportBatch" b
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(b."rows") = 'array' THEN b."rows" ELSE '[]'::jsonb END) WITH ORDINALITY AS r(row, ordinality)
  WHERE b."type" = 'FLIGHTS' AND b."status" = 'COMMITTED'
  GROUP BY b."id", b."result", r.row->'data'->>'flight_number', r.row->'data'->>'flight_date'
), indexed_groups AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY batch_id ORDER BY first_row) - 1 AS group_index FROM source_groups
), candidates AS (
  SELECT "result"->'ids'->>group_index::integer AS flight_id, service_date, departure_iso FROM indexed_groups
  WHERE service_date ~ '^\d{4}-\d{2}-\d{2}$' AND pg_input_is_valid(service_date, 'date')
), recovered AS (
  SELECT flight_id, MIN(service_date) AS service_date, MIN(departure_iso) AS departure_iso
  FROM candidates GROUP BY flight_id HAVING COUNT(DISTINCT service_date) = 1
)
UPDATE "Flight" f SET "serviceDate" = r.service_date::date,
  "scheduleIssue" = CASE WHEN LEFT(r.departure_iso, 10) <> r.service_date
    THEN 'The imported service date and first departure date differ. Review the schedule.' ELSE NULL END
FROM recovered r WHERE f."id" = r.flight_id;

-- Existing drafts and crew completions also freeze catering loads on upgrade.
UPDATE "Flight" f SET "reportingStartedAt" = s.started_at
FROM (
  SELECT "flightId", MIN("createdAt") AS started_at FROM "SyncOperation" GROUP BY "flightId"
  UNION ALL
  SELECT "flightId", MIN("submittedAt") AS started_at FROM "CrewSubmission" GROUP BY "flightId"
) s WHERE f."id" = s."flightId" AND f."reportingStartedAt" IS NULL;

UPDATE "Flight" f
SET "reportingStartedAt" = COALESCE(r."submittedAt", CURRENT_TIMESTAMP)
FROM "FlightReport" r
WHERE r."flightId" = f."id"
  AND r."status" IN ('SUBMITTED', 'FORWARDED', 'RETURNED', 'REJECTED', 'APPROVED');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Flight"
    GROUP BY "flightNumber", "serviceDate"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot backfill serviceDate: duplicate flight/date records exist';
  END IF;
  IF EXISTS (SELECT 1 FROM "CrewAssignment" WHERE "duty" = 'PURSER' GROUP BY "flightId" HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'Cannot upgrade assignments: multiple pursers exist for a flight; review these records first';
  END IF;
END $$;

ALTER TABLE "Flight" ALTER COLUMN "serviceDate" SET NOT NULL;
CREATE INDEX "Flight_serviceDate_status_idx" ON "Flight"("serviceDate", "status");
CREATE UNIQUE INDEX "Flight_flightNumber_serviceDate_key" ON "Flight"("flightNumber", "serviceDate");
CREATE UNIQUE INDEX "CrewAssignment_one_purser_per_flight" ON "CrewAssignment"("flightId") WHERE "duty" = 'PURSER';

CREATE TABLE "ReportRevision" (
  "id" TEXT NOT NULL,
  "reportId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReportRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReportRevision_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "FlightReport"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ReportRevision_reportId_revision_key" ON "ReportRevision"("reportId", "revision");
CREATE INDEX "ReportRevision_reportId_createdAt_idx" ON "ReportRevision"("reportId", "createdAt");

-- Preserve all retained legacy revisions using the historical quantities and the
-- metadata still available at upgrade time. New submissions snapshot every field.
INSERT INTO "ReportRevision" ("id", "reportId", "revision", "snapshot")
SELECT r."id" || ':' || versions.revision, r."id", versions.revision,
  jsonb_build_object(
    'id', r."id", 'status', CASE WHEN versions.revision = r."version" THEN r."status"::text ELSE 'SUBMITTED' END,
    'version', versions.revision, 'legacy', true,
    'purser', jsonb_build_object('id', u."id", 'name', r."purserName", 'email', u."email"),
    'notes', CASE WHEN versions.revision = r."version" THEN COALESCE(r."notes", '') ELSE '' END,
    'submittedAt', CASE WHEN versions.revision = r."version" THEN to_jsonb(r."submittedAt" AT TIME ZONE 'UTC') ELSE NULL END,
    'approvedAt', CASE WHEN versions.revision = r."version" THEN to_jsonb(r."approvedAt" AT TIME ZONE 'UTC') ELSE NULL END,
    'flight', jsonb_build_object('id', f."id", 'flightNumber', f."flightNumber", 'serviceDate', f."serviceDate", 'aircraft', f."aircraft", 'status', f."status",
      'sectors', COALESCE((SELECT jsonb_agg(jsonb_build_object('sequence', s."sequence", 'origin', s."origin", 'destination', s."destination", 'scheduledDeparture', s."scheduledDeparture" AT TIME ZONE 'UTC', 'scheduledArrival', s."scheduledArrival" AT TIME ZONE 'UTC', 'economyPax', s."economyPax", 'businessPax', s."businessPax") ORDER BY s."sequence") FROM "Sector" s WHERE s."flightId" = f."id"), '[]'::jsonb)),
    'lines', COALESCE((SELECT jsonb_agg(jsonb_build_object('manifestLineId', ml."id", 'sector', s."sequence", 'origin', s."origin", 'destination', s."destination", 'cabin', m."cabin", 'sku', i."sku", 'item', i."nameEn", 'unit', i."unit", 'loaded', ml."loaded", 'consumed', rl."consumed", 'returned', rl."returned", 'spoiled', rl."spoiled", 'discarded', rl."discarded", 'unexplained', rl."unexplained", 'remarks', COALESCE(rl."remarks", '')) ORDER BY s."sequence", m."cabin", i."sku")
      FROM "ReportLine" rl JOIN "ManifestLine" ml ON ml."id" = rl."manifestLineId" JOIN "Manifest" m ON m."id" = ml."manifestId" JOIN "Sector" s ON s."id" = m."sectorId" JOIN "CatalogItem" i ON i."id" = ml."itemId"
      WHERE rl."reportId" = r."id" AND rl."revision" = versions.revision), '[]'::jsonb),
    'reviewHistory', COALESCE((SELECT jsonb_agg(jsonb_build_object('decision', a."decision", 'actorName', a."actorName", 'reason', COALESCE(a."reason", ''), 'createdAt', a."createdAt" AT TIME ZONE 'UTC') ORDER BY a."createdAt") FROM "Approval" a WHERE a."reportId" = r."id"), '[]'::jsonb)
  )
FROM "FlightReport" r JOIN "Flight" f ON f."id" = r."flightId" JOIN "User" u ON u."id" = r."purserId"
CROSS JOIN LATERAL (SELECT r."version" AS revision UNION SELECT rl."revision" FROM "ReportLine" rl WHERE rl."reportId" = r."id") versions;

COMMIT;
