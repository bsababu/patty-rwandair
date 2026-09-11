-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ATTENDANT', 'LEAD', 'PROCUREMENT', 'DIRECTOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "Cabin" AS ENUM ('ECONOMY', 'BUSINESS');

-- CreateEnum
CREATE TYPE "FlightStatus" AS ENUM ('SCHEDULED', 'BOARDING', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'RETURNED', 'REJECTED', 'APPROVED');

-- CreateEnum
CREATE TYPE "MovementReason" AS ENUM ('LOAD', 'APPROVED_CONSUMPTION', 'RETURN', 'SPOILAGE', 'DISCARD', 'CORRECTION', 'REVERSAL', 'RECEIPT');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "passwordChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Flight" (
    "id" TEXT NOT NULL,
    "flightNumber" TEXT NOT NULL,
    "flightDate" TIMESTAMP(3) NOT NULL,
    "aircraft" TEXT NOT NULL,
    "status" "FlightStatus" NOT NULL DEFAULT 'SCHEDULED',
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Flight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sector" (
    "id" TEXT NOT NULL,
    "flightId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "origin" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "scheduledDeparture" TIMESTAMP(3) NOT NULL,
    "scheduledArrival" TIMESTAMP(3) NOT NULL,
    "economyPax" INTEGER NOT NULL,
    "businessPax" INTEGER NOT NULL,

    CONSTRAINT "Sector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrewAssignment" (
    "id" TEXT NOT NULL,
    "flightId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "duty" TEXT NOT NULL,

    CONSTRAINT "CrewAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogItem" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameFr" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "shelfLifeHours" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "reorderPoint" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CatalogItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemPrice" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RWF',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),

    CONSTRAINT "ItemPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryLot" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "supplier" TEXT,
    "lotCode" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Manifest" (
    "id" TEXT NOT NULL,
    "flightId" TEXT NOT NULL,
    "sectorId" TEXT NOT NULL,
    "cabin" "Cabin" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',

    CONSTRAINT "Manifest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManifestLine" (
    "id" TEXT NOT NULL,
    "manifestId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "suggested" INTEGER NOT NULL,
    "planned" INTEGER NOT NULL,
    "approved" INTEGER NOT NULL,
    "loaded" INTEGER NOT NULL,
    "consumed" INTEGER NOT NULL DEFAULT 0,
    "returned" INTEGER NOT NULL DEFAULT 0,
    "spoiled" INTEGER NOT NULL DEFAULT 0,
    "discarded" INTEGER NOT NULL DEFAULT 0,
    "overrideReason" TEXT,

    CONSTRAINT "ManifestLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlightReport" (
    "id" TEXT NOT NULL,
    "flightId" TEXT NOT NULL,
    "purserId" TEXT NOT NULL,
    "purserName" TEXT NOT NULL,
    "notes" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "FlightReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportLine" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "manifestLineId" TEXT NOT NULL,
    "consumed" INTEGER NOT NULL,
    "returned" INTEGER NOT NULL,
    "spoiled" INTEGER NOT NULL,
    "discarded" INTEGER NOT NULL,
    "unexplained" INTEGER NOT NULL,

    CONSTRAINT "ReportLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "decision" "ReportStatus" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" "MovementReason" NOT NULL,
    "flightId" TEXT,
    "reversalOfId" TEXT,
    "operationId" TEXT NOT NULL,
    "unitCostMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RWF',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Forecast" (
    "id" TEXT NOT NULL,
    "flightId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "cabin" "Cabin" NOT NULL,
    "baseline" DOUBLE PRECISION NOT NULL,
    "safetyBuffer" DOUBLE PRECISION NOT NULL,
    "suggested" INTEGER NOT NULL,
    "approved" INTEGER,
    "confidence" TEXT NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "explanation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Forecast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "key" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "SyncOperation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "flightId" TEXT NOT NULL,
    "manifestVersion" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'APPLIED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Flight_flightDate_status_idx" ON "Flight"("flightDate", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Flight_flightNumber_flightDate_key" ON "Flight"("flightNumber", "flightDate");

-- CreateIndex
CREATE UNIQUE INDEX "Sector_flightId_sequence_key" ON "Sector"("flightId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "CrewAssignment_flightId_userId_key" ON "CrewAssignment"("flightId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogItem_sku_key" ON "CatalogItem"("sku");

-- CreateIndex
CREATE INDEX "ItemPrice_itemId_effectiveFrom_idx" ON "ItemPrice"("itemId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "Manifest_sectorId_cabin_key" ON "Manifest"("sectorId", "cabin");

-- CreateIndex
CREATE UNIQUE INDEX "ManifestLine_manifestId_itemId_key" ON "ManifestLine"("manifestId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "FlightReport_flightId_key" ON "FlightReport"("flightId");

-- CreateIndex
CREATE UNIQUE INDEX "ReportLine_reportId_manifestLineId_key" ON "ReportLine"("reportId", "manifestLineId");

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_operationId_key" ON "StockMovement"("operationId");

-- CreateIndex
CREATE INDEX "StockMovement_itemId_createdAt_idx" ON "StockMovement"("itemId", "createdAt");

-- CreateIndex
CREATE INDEX "StockMovement_flightId_idx" ON "StockMovement"("flightId");

-- CreateIndex
CREATE INDEX "Forecast_flightId_idx" ON "Forecast"("flightId");

-- CreateIndex
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "AuditEvent"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt");

-- CreateIndex
CREATE INDEX "IdempotencyKey_expiresAt_idx" ON "IdempotencyKey"("expiresAt");

-- CreateIndex
CREATE INDEX "SyncOperation_flightId_createdAt_idx" ON "SyncOperation"("flightId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Sector" ADD CONSTRAINT "Sector_flightId_fkey" FOREIGN KEY ("flightId") REFERENCES "Flight"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewAssignment" ADD CONSTRAINT "CrewAssignment_flightId_fkey" FOREIGN KEY ("flightId") REFERENCES "Flight"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewAssignment" ADD CONSTRAINT "CrewAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemPrice" ADD CONSTRAINT "ItemPrice_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "CatalogItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLot" ADD CONSTRAINT "InventoryLot_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "CatalogItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Manifest" ADD CONSTRAINT "Manifest_flightId_fkey" FOREIGN KEY ("flightId") REFERENCES "Flight"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Manifest" ADD CONSTRAINT "Manifest_sectorId_fkey" FOREIGN KEY ("sectorId") REFERENCES "Sector"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManifestLine" ADD CONSTRAINT "ManifestLine_manifestId_fkey" FOREIGN KEY ("manifestId") REFERENCES "Manifest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManifestLine" ADD CONSTRAINT "ManifestLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "CatalogItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlightReport" ADD CONSTRAINT "FlightReport_flightId_fkey" FOREIGN KEY ("flightId") REFERENCES "Flight"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlightReport" ADD CONSTRAINT "FlightReport_purserId_fkey" FOREIGN KEY ("purserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportLine" ADD CONSTRAINT "ReportLine_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "FlightReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "FlightReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "CatalogItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
