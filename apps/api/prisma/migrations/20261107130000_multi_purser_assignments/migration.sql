CREATE TABLE "CateringListPurser" (
    "id" TEXT NOT NULL,
    "cateringListId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CateringListPurser_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CateringListPurser_cateringListId_userId_key" ON "CateringListPurser"("cateringListId", "userId");
CREATE INDEX "CateringListPurser_userId_assignedAt_idx" ON "CateringListPurser"("userId", "assignedAt");

ALTER TABLE "CateringListPurser" ADD CONSTRAINT "CateringListPurser_cateringListId_fkey"
  FOREIGN KEY ("cateringListId") REFERENCES "CateringList"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CateringListPurser" ADD CONSTRAINT "CateringListPurser_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Preserve the existing single-Purser assignment while allowing additional Pursers.
INSERT INTO "CateringListPurser" ("id", "cateringListId", "userId")
SELECT md5('catering-purser:' || "id"), "id", "purserId"
FROM "CateringList"
WHERE "purserId" IS NOT NULL
ON CONFLICT ("cateringListId", "userId") DO NOTHING;
