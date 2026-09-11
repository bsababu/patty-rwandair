-- Durable, auditable preview and commit records for Lead CSV imports.
CREATE TYPE "ImportType" AS ENUM ('FLIGHTS', 'CATERING', 'CREW');
CREATE TYPE "ImportStatus" AS ENUM ('PREVIEWED', 'COMMITTED', 'CANCELLED', 'FAILED');

CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "type" "ImportType" NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'PREVIEWED',
    "fileName" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "sourceText" TEXT NOT NULL,
    "rows" JSONB NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "errorCount" INTEGER NOT NULL,
    "actorId" TEXT NOT NULL,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ImportBatch_actorId_createdAt_idx" ON "ImportBatch"("actorId", "createdAt");
CREATE INDEX "ImportBatch_type_status_createdAt_idx" ON "ImportBatch"("type", "status", "createdAt");

ALTER TABLE "ImportBatch"
ADD CONSTRAINT "ImportBatch_actorId_fkey"
FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
