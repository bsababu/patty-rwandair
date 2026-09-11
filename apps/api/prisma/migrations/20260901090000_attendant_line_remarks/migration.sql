-- Add optional operational context to each reconciled catering item.
ALTER TABLE "ManifestLine" ADD COLUMN "remarks" TEXT;
ALTER TABLE "ReportLine" ADD COLUMN "remarks" TEXT;
