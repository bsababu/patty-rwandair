ALTER TYPE "ReportStatus" ADD VALUE IF NOT EXISTS 'FORWARDED' AFTER 'SUBMITTED';

CREATE TABLE "CateringList" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "flightNumber" TEXT NOT NULL,
    "serviceDate" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CateringList_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CateringListLine" (
    "id" TEXT NOT NULL,
    "cateringListId" TEXT NOT NULL,
    "sectorSequence" INTEGER NOT NULL,
    "cabin" "Cabin" NOT NULL,
    "itemId" TEXT NOT NULL,
    "suggested" INTEGER NOT NULL,
    "planned" INTEGER NOT NULL,
    "approved" INTEGER NOT NULL,
    "loaded" INTEGER NOT NULL,
    "overrideReason" TEXT,
    CONSTRAINT "CateringListLine_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Flight" ADD COLUMN "leadId" TEXT;
ALTER TABLE "Flight" ADD COLUMN "cateringListId" TEXT;

CREATE UNIQUE INDEX "CateringList_name_key" ON "CateringList"("name");
CREATE UNIQUE INDEX "CateringList_flightNumber_serviceDate_key" ON "CateringList"("flightNumber", "serviceDate");
CREATE INDEX "CateringList_flightNumber_serviceDate_status_idx" ON "CateringList"("flightNumber", "serviceDate", "status");
CREATE UNIQUE INDEX "CateringListLine_cateringListId_sectorSequence_cabin_itemId_key" ON "CateringListLine"("cateringListId", "sectorSequence", "cabin", "itemId");
CREATE INDEX "CateringListLine_itemId_idx" ON "CateringListLine"("itemId");
CREATE INDEX "Flight_leadId_flightDate_idx" ON "Flight"("leadId", "flightDate");
CREATE INDEX "Flight_cateringListId_idx" ON "Flight"("cateringListId");

ALTER TABLE "CateringList" ADD CONSTRAINT "CateringList_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CateringListLine" ADD CONSTRAINT "CateringListLine_cateringListId_fkey" FOREIGN KEY ("cateringListId") REFERENCES "CateringList"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CateringListLine" ADD CONSTRAINT "CateringListLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "CatalogItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Flight" ADD CONSTRAINT "Flight_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Flight" ADD CONSTRAINT "Flight_cateringListId_fkey" FOREIGN KEY ("cateringListId") REFERENCES "CateringList"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CateringListLine" ADD CONSTRAINT "CateringListLine_nonnegative_quantities" CHECK (
    "sectorSequence" > 0 AND "suggested" >= 0 AND "planned" >= 0 AND
    "approved" >= 0 AND "loaded" >= 0 AND "loaded" <= "approved"
);

UPDATE "Flight"
SET "leadId" = (SELECT "id" FROM "User" WHERE "email" = 'lead@wings.rw')
WHERE "flightNumber" IN ('WB 402', 'WB 435')
  AND "leadId" IS NULL
  AND EXISTS (SELECT 1 FROM "User" WHERE "email" = 'lead@wings.rw');
