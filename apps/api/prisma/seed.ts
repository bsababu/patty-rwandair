import { PrismaClient, Cabin, Role } from "@prisma/client";
import { hash } from "argon2";

const db = new PrismaClient();

async function main() {
  const seedKey = "fictional-demo-v1";
  if (await db.seedRun.findUnique({ where: { key: seedKey } })) {
    console.log("Fictional demo seed already completed; existing data preserved");
    return;
  }

  const passwordHash = await hash(process.env.DEMO_PASSWORD || "Wings2026!");
  const definitions: [string, string, Role][] = [
    ["attendant@wings.rw", "Uwase Keza", Role.ATTENDANT],
    ["lead@wings.rw", "Mugisha Eric", Role.LEAD],
    ["procurement@wings.rw", "Mukamana Aline", Role.PROCUREMENT],
    ["director@wings.rw", "Niyonzima Jean", Role.DIRECTOR],
    ["admin@wings.rw", "System Administrator", Role.ADMIN],
    ["attendant2@wings.rw", "Ineza Diane", Role.ATTENDANT],
    ["attendant3@wings.rw", "Habimana Claude", Role.ATTENDANT],
    ["attendant4@wings.rw", "Mutoni Grace", Role.ATTENDANT],
  ];
  const users = await Promise.all(
    definitions.map(([email, name, role]) =>
      db.user.upsert({ where: { email }, update: {}, create: { email, name, role, passwordHash } }),
    ),
  );

  const catalog: [string, string, string, string, string, number, number][] = [
    ["MEAL-CHK", "Chicken brochette meal", "Repas brochette de poulet", "Hot meals", "meal", 850, 7500],
    ["MEAL-VEG", "Vegetarian isombe meal", "Repas isombe végétarien", "Hot meals", "meal", 180, 6800],
    ["WATER-500", "Akagera still water", "Eau plate Akagera", "Beverages", "bottle", 600, 900],
    ["COFFEE-RW", "Rwandan coffee", "Café rwandais", "Beverages", "cup", 120, 1200],
  ];
  const items = [];
  for (const [sku, nameEn, nameFr, category, unit, reorderPoint, price] of catalog) {
    const item = await db.catalogItem.upsert({ where: { sku }, update: {}, create: { sku, nameEn, nameFr, category, unit, reorderPoint } });
    await db.itemPrice.upsert({
      where: { id: "seed-price-" + sku },
      update: {},
      create: { id: "seed-price-" + sku, itemId: item.id, amountMinor: BigInt(price), currency: "RWF", effectiveFrom: new Date("2026-01-01") },
    });
    await db.inventoryLot.upsert({
      where: { id: "seed-lot-" + sku },
      update: {},
      create: { id: "seed-lot-" + sku, itemId: item.id, lotCode: "DEMO-" + sku, quantity: reorderPoint * 2, supplier: "Demo Catering Supplier" },
    });
    items.push(item);
  }

  const run = await db.cateringList.upsert({
    where: { flightNumber_serviceDate: { flightNumber: "WB 435", serviceDate: new Date("2026-09-01T00:00:00.000Z") } },
    update: {},
    create: { name: "WB 435 · 2026-09-01", flightNumber: "WB 435", serviceDate: new Date("2026-09-01T00:00:00.000Z"), createdById: users[2].id },
  });
  await db.cateringList.updateMany({ where: { id: run.id, leadId: null }, data: { leadId: users[1].id } });
  await db.cateringList.updateMany({ where: { id: run.id, purserId: null }, data: { purserId: users[0].id } });
  await db.cateringListPurser.createMany({
    data: [users[0], users[5], users[6]].map((user) => ({ cateringListId: run.id, userId: user.id })),
    skipDuplicates: true,
  });

  for (const cabin of [Cabin.ECONOMY, Cabin.BUSINESS]) {
    for (const [index, item] of items.entries()) {
      const loaded = cabin === Cabin.ECONOMY ? [108, 30, 154, 84][index] : [16, 4, 26, 18][index];
      await db.cateringListLine.upsert({
        where: { cateringListId_sectorSequence_cabin_itemId: { cateringListId: run.id, sectorSequence: 1, cabin, itemId: item.id } },
        update: {},
        create: { cateringListId: run.id, sectorSequence: 1, cabin, itemId: item.id, suggested: Math.max(1, loaded - 4), planned: loaded, approved: loaded, loaded },
      });
    }
  }

  for (const user of users)
    await db.notification.upsert({
      where: { id: "welcome-" + user.id },
      update: {},
      create: { id: "welcome-" + user.id, userId: user.id, title: "Welcome to RwandAir Catering Control", body: "This environment contains clearly labeled fictional demonstration data." },
    });
  await db.seedRun.create({ data: { key: seedKey } });
  console.log("Seeded RwandAir Catering Control pilot data");
}

main().finally(() => db.$disconnect());
