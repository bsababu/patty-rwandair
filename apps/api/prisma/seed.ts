import { PrismaClient, Cabin, FlightStatus, Role } from "@prisma/client";
import { hash } from "argon2";
const db = new PrismaClient();
async function main() {
  const seedKey = "fictional-demo-v1";
  const completed = await db.seedRun.findUnique({ where: { key: seedKey } });
  if (completed) {
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
      db.user.upsert({
        where: { email },
        update: {},
        create: { email, name, role, passwordHash },
      }),
    ),
  );
  const catalog: [string, string, string, string, string, number, number][] = [
    [
      "MEAL-CHK",
      "Chicken brochette meal",
      "Repas brochette de poulet",
      "Hot meals",
      "meal",
      850,
      7500,
    ],
    [
      "MEAL-VEG",
      "Vegetarian isombe meal",
      "Repas isombe végétarien",
      "Hot meals",
      "meal",
      180,
      6800,
    ],
    [
      "WATER-500",
      "Akagera still water",
      "Eau plate Akagera",
      "Beverages",
      "bottle",
      600,
      900,
    ],
    [
      "COFFEE-RW",
      "Rwandan coffee",
      "Café rwandais",
      "Beverages",
      "cup",
      120,
      1200,
    ],
  ];
  const items = [];
  for (const [
    sku,
    nameEn,
    nameFr,
    category,
    unit,
    reorderPoint,
    price,
  ] of catalog) {
    const item = await db.catalogItem.upsert({
      where: { sku },
      update: {},
      create: { sku, nameEn, nameFr, category, unit, reorderPoint },
    });
    await db.itemPrice.upsert({
      where: { id: "seed-price-" + sku },
      update: {},
      create: {
        id: "seed-price-" + sku,
        itemId: item.id,
        amountMinor: BigInt(price),
        currency: "RWF",
        effectiveFrom: new Date("2026-01-01"),
      },
    });
    await db.inventoryLot.upsert({
      where: { id: "seed-lot-" + sku },
      update: {},
      create: {
        id: "seed-lot-" + sku,
        itemId: item.id,
        lotCode: "DEMO-" + sku,
        quantity: reorderPoint * 2,
        supplier: "Demo Catering Supplier",
      },
    });
    items.push(item);
  }
  const flightDate = new Date("2026-08-30T12:20:00Z");
  const flight = await db.flight.upsert({
    where: { flightNumber_flightDate: { flightNumber: "WB 402", flightDate } },
    update: {},
    create: {
      flightNumber: "WB 402",
      flightDate,
      aircraft: "B737-800",
      status: FlightStatus.ACTIVE,
      leadId: users[1].id,
    },
  });
  const sector = await db.sector.upsert({
    where: { flightId_sequence: { flightId: flight.id, sequence: 1 } },
    update: {},
    create: {
      flightId: flight.id,
      sequence: 1,
      origin: "KGL",
      destination: "NBO",
      scheduledDeparture: flightDate,
      scheduledArrival: new Date("2026-08-30T14:00:00Z"),
      economyPax: 144,
      businessPax: 12,
    },
  });
  await db.crewAssignment.upsert({
    where: { flightId_userId: { flightId: flight.id, userId: users[0].id } },
    update: {},
    create: { flightId: flight.id, userId: users[0].id, duty: "PURSER" },
  });
  for (const cabin of [Cabin.ECONOMY, Cabin.BUSINESS]) {
    const manifest = await db.manifest.upsert({
      where: { sectorId_cabin: { sectorId: sector.id, cabin } },
      update: {},
      create: {
        flightId: flight.id,
        sectorId: sector.id,
        cabin,
        status: "DRAFT",
      },
    });
    for (const [i, item] of items.entries()) {
      const loaded =
        cabin === Cabin.ECONOMY ? [118, 26, 180, 92][i] : [18, 4, 30, 20][i];
      await db.manifestLine.upsert({
        where: {
          manifestId_itemId: { manifestId: manifest.id, itemId: item.id },
        },
        update: {},
        create: {
          manifestId: manifest.id,
          itemId: item.id,
          loaded,
          planned: loaded,
          approved: loaded,
          suggested: Math.max(1, loaded - 5),
        },
      });
    }
  }
  for (const cabin of [Cabin.ECONOMY, Cabin.BUSINESS])
    await db.forecast.upsert({
      where: { id: `seed-forecast-${flight.id}-${cabin}` },
      update: {},
      create: {
        id: `seed-forecast-${flight.id}-${cabin}`,
        flightId: flight.id,
        itemId: items[0].id,
        cabin,
        baseline: cabin === Cabin.ECONOMY ? 137 : 12,
        safetyBuffer: cabin === Cabin.ECONOMY ? 7 : 1,
        suggested: cabin === Cabin.ECONOMY ? 144 : 13,
        confidence: "HIGH",
        sampleSize: 18,
        explanation:
          "Recent KGL–NBO passenger-normalized consumption plus a 5% safety buffer.",
      },
    });

  // Keep a separate editable assignment available for attendant demonstrations.
  // The empty update clauses ensure reseeding never rewrites operational progress.
  const editableDate = new Date("2026-09-01T10:10:00Z");
  const editableFlight = await db.flight.upsert({
    where: {
      flightNumber_flightDate: {
        flightNumber: "WB 435",
        flightDate: editableDate,
      },
    },
    update: {},
    create: {
      flightNumber: "WB 435",
      flightDate: editableDate,
      aircraft: "B737-800",
      status: FlightStatus.ACTIVE,
      leadId: users[1].id,
    },
  });
  const editableSector = await db.sector.upsert({
    where: {
      flightId_sequence: { flightId: editableFlight.id, sequence: 1 },
    },
    update: {},
    create: {
      flightId: editableFlight.id,
      sequence: 1,
      origin: "KGL",
      destination: "EBB",
      scheduledDeparture: editableDate,
      scheduledArrival: new Date("2026-09-01T11:20:00Z"),
      economyPax: 132,
      businessPax: 12,
    },
  });
  await db.crewAssignment.upsert({
    where: {
      flightId_userId: {
        flightId: editableFlight.id,
        userId: users[0].id,
      },
    },
    update: {},
    create: {
      flightId: editableFlight.id,
      userId: users[0].id,
      duty: "PURSER",
    },
  });
  for (const cabin of [Cabin.ECONOMY, Cabin.BUSINESS]) {
    const manifest = await db.manifest.upsert({
      where: {
        sectorId_cabin: { sectorId: editableSector.id, cabin },
      },
      update: {},
      create: {
        flightId: editableFlight.id,
        sectorId: editableSector.id,
        cabin,
        status: "DRAFT",
      },
    });
    for (const [index, item] of items.entries()) {
      const loaded =
        cabin === Cabin.ECONOMY
          ? [108, 30, 154, 84][index]
          : [16, 4, 26, 18][index];
      await db.manifestLine.upsert({
        where: {
          manifestId_itemId: { manifestId: manifest.id, itemId: item.id },
        },
        update: {},
        create: {
          manifestId: manifest.id,
          itemId: item.id,
          loaded,
          planned: loaded,
          approved: loaded,
          suggested: Math.max(1, loaded - 4),
        },
      });
    }
  }
  const seededCateringList = await db.cateringList.upsert({
    where: {
      flightNumber_serviceDate: {
        flightNumber: "WB 435",
        serviceDate: new Date("2026-09-01T00:00:00.000Z"),
      },
    },
    update: {},
    create: {
      name: "WB 435 · 2026-09-01",
      flightNumber: "WB 435",
      serviceDate: new Date("2026-09-01T00:00:00.000Z"),
      createdById: users[2].id,
    },
  });
  for (const cabin of [Cabin.ECONOMY, Cabin.BUSINESS]) {
    for (const [index, item] of items.entries()) {
      const loaded =
        cabin === Cabin.ECONOMY
          ? [108, 30, 154, 84][index]
          : [16, 4, 26, 18][index];
      await db.cateringListLine.upsert({
        where: {
          cateringListId_sectorSequence_cabin_itemId: {
            cateringListId: seededCateringList.id,
            sectorSequence: 1,
            cabin,
            itemId: item.id,
          },
        },
        update: {},
        create: {
          cateringListId: seededCateringList.id,
          sectorSequence: 1,
          cabin,
          itemId: item.id,
          suggested: Math.max(1, loaded - 4),
          planned: loaded,
          approved: loaded,
          loaded,
        },
      });
    }
  }
  for (const user of users)
    await db.notification.upsert({
      where: { id: "welcome-" + user.id },
      update: {},
      create: {
        id: "welcome-" + user.id,
        userId: user.id,
        title: "Welcome to RwandAir Catering Control",
        body: "This environment contains clearly labeled fictional demonstration data.",
      },
    });
  await db.seedRun.create({ data: { key: seedKey } });
  console.log("Seeded RwandAir Catering Control pilot data");
}
main().finally(() => db.$disconnect());
