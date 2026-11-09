-- Preserve closed legacy work without rewriting previously applied migrations.
UPDATE "CateringList" c
SET "status" = 'CANCELLED', "version" = c."version" + 1, "updatedAt" = CURRENT_TIMESTAMP
FROM "Flight" f
WHERE f."cateringListId" = c."id"
  AND f."status" = 'CANCELLED'
  AND c."status" <> 'CANCELLED';
