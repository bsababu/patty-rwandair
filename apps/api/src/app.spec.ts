import assert from "node:assert/strict";
import test from "node:test";
import { ImportType } from "@prisma/client";
import { validateImport } from "./app";

test("validates the minimal catering template without an optional cabin", async () => {
  const database = {
    catalogItem: {
      findFirst: async () => ({ id: "item-1", sku: "MEAL-CHK", nameEn: "Chicken brochette meal", active: true }),
    },
    cateringList: {
      findUnique: async () => null,
    },
  } as never;
  const rows = await validateImport(
    ImportType.CATERING,
    "flight_number,service_date,item,loaded\nWB700,2026-11-04,Chicken brochette meal,108\n",
    database,
  );
  assert.deepEqual(rows[0].errors, []);
  assert.equal(rows[0].data.cabin, "ECONOMY");
  assert.equal(rows[0].data.suggested, "108");
  assert.equal(rows[0].data.approved, "108");
});
