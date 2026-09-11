ALTER TYPE "MovementReason" ADD VALUE IF NOT EXISTS 'MISSING' AFTER 'DISCARD';

ALTER TABLE "User" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "ReportLine" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
DROP INDEX "ReportLine_reportId_manifestLineId_key";
CREATE UNIQUE INDEX "ReportLine_reportId_manifestLineId_revision_key" ON "ReportLine"("reportId", "manifestLineId", "revision");
CREATE INDEX "ReportLine_reportId_revision_idx" ON "ReportLine"("reportId", "revision");

CREATE TABLE "SeedRun" (
    "key" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SeedRun_pkey" PRIMARY KEY ("key")
);

INSERT INTO "SeedRun" ("key")
SELECT 'fictional-demo-v1'
WHERE EXISTS (SELECT 1 FROM "User" WHERE "email" = 'attendant@wings.rw')
  AND EXISTS (SELECT 1 FROM "CatalogItem" WHERE "sku" = 'MEAL-CHK')
  AND EXISTS (SELECT 1 FROM "Flight" WHERE "flightNumber" = 'WB 402')
ON CONFLICT ("key") DO NOTHING;

ALTER TABLE "Sector" ADD CONSTRAINT "Sector_nonnegative_passengers" CHECK (
  "economyPax" >= 0 AND "businessPax" >= 0 AND "scheduledArrival" > "scheduledDeparture"
);
ALTER TABLE "ManifestLine" ADD CONSTRAINT "ManifestLine_valid_quantities" CHECK (
  "suggested" >= 0 AND "planned" >= 0 AND "approved" >= 0 AND "loaded" >= 0 AND
  "consumed" >= 0 AND "returned" >= 0 AND "spoiled" >= 0 AND "discarded" >= 0 AND
  "loaded" <= "approved" AND
  "consumed" + "returned" + "spoiled" + "discarded" <= "loaded"
);
ALTER TABLE "ReportLine" ADD CONSTRAINT "ReportLine_valid_quantities" CHECK (
  "consumed" >= 0 AND "returned" >= 0 AND "spoiled" >= 0 AND "discarded" >= 0 AND
  "unexplained" >= 0 AND "revision" > 0
);
ALTER TABLE "InventoryLot" ADD CONSTRAINT "InventoryLot_nonnegative_quantity" CHECK ("quantity" >= 0);
ALTER TABLE "ItemPrice" ADD CONSTRAINT "ItemPrice_valid_range" CHECK (
  "amountMinor" >= 0 AND ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom")
);
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_nonzero_quantity" CHECK ("quantity" <> 0);
