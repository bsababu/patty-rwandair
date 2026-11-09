import type { PrismaClient } from "@prisma/client";

/** Delete only records owned by the explicitly supplied isolated-test users/items. */
export async function cleanupRunFixtures(db: PrismaClient, userIds: string[], itemIds: string[]) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !/test|verification/i.test(new URL(url).pathname)) throw new Error("Fixture cleanup requires an isolated test database");
  const runs = await db.cateringList.findMany({ where: { createdById: { in: userIds } }, select: { id: true } });
  const runIds = runs.map((run) => run.id);
  const reports = await db.cateringRunReport.findMany({ where: { cateringListId: { in: runIds } }, select: { id: true } });
  const reportIds = reports.map((report) => report.id);
  await db.$transaction(async (tx) => {
    await tx.cateringRunApproval.deleteMany({ where: { reportId: { in: reportIds } } });
    await tx.stockMovement.deleteMany({ where: { runId: { in: runIds } } });
    await tx.cateringRunReport.deleteMany({ where: { id: { in: reportIds } } });
    await tx.cateringListLine.deleteMany({ where: { cateringListId: { in: runIds } } });
    await tx.cateringListPurser.deleteMany({ where: { cateringListId: { in: runIds } } });
    await tx.cateringList.deleteMany({ where: { id: { in: runIds } } });
    await tx.importBatch.deleteMany({ where: { actorId: { in: userIds } } });
    await tx.notification.deleteMany({ where: { userId: { in: userIds } } });
    await tx.auditEvent.deleteMany({ where: { actorId: { in: userIds } } });
    await tx.session.deleteMany({ where: { userId: { in: userIds } } });
    await tx.user.deleteMany({ where: { id: { in: userIds } } });
    await tx.itemPrice.deleteMany({ where: { itemId: { in: itemIds } } });
    await tx.inventoryLot.deleteMany({ where: { itemId: { in: itemIds } } });
    await tx.catalogItem.deleteMany({ where: { id: { in: itemIds } } });
    if (reportIds.length) await tx.idempotencyKey.deleteMany({ where: { OR: reportIds.map((id) => ({ response: { path: ["id"], equals: id } })) } });
  });
}
