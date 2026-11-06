import { test, expect, type Page } from "@playwright/test";
import { PrismaClient, Role, FlightStatus } from "../apps/api/node_modules/@prisma/client/default.js";
import { hash } from "../apps/api/node_modules/argon2/argon2.cjs";
import { promises as fs } from "node:fs";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl || !/test|verification/i.test(new URL(testDatabaseUrl).pathname)) throw new Error("TEST_DATABASE_URL must identify an isolated test database");
const db = new PrismaClient({ datasourceUrl: testDatabaseUrl });
const password = "E2E-Only-Password-2026!";
const serviceDate = "2026-11-04";
const flightNumber = `WB${Math.floor(700 + Math.random() * 200)}`;
const normalizedFlightNumber = `WB ${flightNumber.slice(2)}`;
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const sku = `E2E-MEAL-${suffix}`.toUpperCase();
const accounts = {
  catering: { email: `catering-${suffix}@example.test`, name: `E2E Catering ${suffix}`, role: Role.PROCUREMENT },
  lead: { email: `cabin-${suffix}@example.test`, name: `E2E Cabin Services ${suffix}`, role: Role.LEAD },
  purser: { email: `purser-${suffix}@example.test`, name: `E2E Flight Purser ${suffix}`, role: Role.ATTENDANT },
};

const flightsCsv = () => [
  "flight_number,flight_date,aircraft,sector_sequence,origin,destination,departure_iso,arrival_iso,economy_pax,business_pax",
  `${flightNumber},${serviceDate},A330-300,1,KGL,NBO,${serviceDate}T00:30:00+02:00,${serviceDate}T04:00:00+03:00,120,12`,
  `${flightNumber},${serviceDate},A330-300,2,NBO,KGL,2026-11-05T01:30:00+03:00,2026-11-05T03:30:00+02:00,118,10`,
].join("\n") + "\n";

const cateringCsv = (sku: string) => [
  "flight_number,flight_date,sector_sequence,cabin,item_sku,suggested,planned,approved,loaded,override_reason",
  `${flightNumber},${serviceDate},1,ECONOMY,${sku},100,100,100,100,`,
  `${flightNumber},${serviceDate},1,BUSINESS,${sku},12,12,12,12,`,
  `${flightNumber},${serviceDate},2,ECONOMY,${sku},98,98,98,98,`,
  `${flightNumber},${serviceDate},2,BUSINESS,${sku},10,10,10,10,`,
].join("\n") + "\n";

async function login(page: Page, account: { email: string }) {
  await page.goto("/");
  await page.locator('input[autocomplete="username"]').fill(account.email);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.getByRole("button", { name: /sign in securely/i }).click();
  await expect(page.locator(".role-label")).toBeVisible();
}

async function logout(page: Page) {
  const signOut = page.getByRole("button", { name: /sign out/i });
  await expect(signOut).toHaveCount(1);
  await expect(signOut).toBeVisible();
  await signOut.click();
  await expect(page.locator('input[autocomplete="username"]')).toBeVisible();
}

async function upload(page: Page, kind: "FLIGHTS" | "CATERING", csv: string) {
  await page.getByRole("button", { name: kind === "FLIGHTS" ? "FLIGHTS" : "CATERING" }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: `${kind.toLowerCase()}-${suffix}.csv`,
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  await page.getByRole("button", { name: /preview and validate/i }).click();
  await expect(page.getByText("Ready to commit")).toBeVisible();
  await page.getByRole("button", { name: /commit import/i }).click();
  await expect(page.getByText(/import committed successfully/i)).toBeVisible();
}

test.describe("RwandAir end-to-end catering workflow", () => {
  test.setTimeout(120_000);

  test.beforeAll(async () => {
    const passwordHash = await hash(password);
    await db.user.createMany({
      data: Object.values(accounts).map((account) => ({ ...account, passwordHash })),
    });
    await db.catalogItem.create({
      data: {
        sku,
        nameEn: "E2E chicken meal",
        nameFr: "Repas E2E",
        category: "Hot meals",
        unit: "meal",
        reorderPoint: 0,
        prices: { create: { amountMinor: 1000, currency: "RWF", effectiveFrom: new Date("2026-01-01") } },
        lots: { create: { lotCode: `E2E-${suffix}`, quantity: 1000 } },
      },
    });
  });

  test.afterAll(async () => {
    await db.$disconnect();
  });

  test("imports, assigns, reports, reviews, exports and posts once", async ({ page }) => {
    await login(page, accounts.catering);
    await page.getByRole("button", { name: /upload data/i }).click();
    await expect(page.getByRole("button", { name: "FLIGHTS", exact: true })).toHaveClass(/active/);
    const samples: string[][] = [];
    for (const type of ["FLIGHTS", "CATERING"]) {
      await page.getByRole("button", { name: type, exact: true }).click();
      const downloaded = page.waitForEvent("download");
      await page.getByRole("button", { name: "Download template", exact: true }).click();
      const path = await (await downloaded).path();
      samples.push((await fs.readFile(path!, "utf8")).split(/\r?\n/)[1].split(",").slice(0, 2));
    }
    expect(samples[0]).toEqual(["WB700", "2026-11-04"]);
    expect(samples[1]).toEqual(samples[0]);
    await upload(page, "FLIGHTS", flightsCsv());
    await upload(page, "CATERING", cateringCsv(sku));
    const auth = await (await page.request.get("/api/v1/auth/me")).json();
    const largeValidCsv = cateringCsv(sku).split("\n").slice(0, 2).join("\n").replace(/,$/, "," + "A".repeat(150_000));
    const largePreview = await page.request.post("/api/v1/imports/preview", { headers: { "x-csrf-token": auth.csrf }, data: { type: "CATERING", fileName: "large-valid.csv", csv: largeValidCsv } });
    expect(largePreview.ok()).toBeTruthy();
    expect((await largePreview.json()).errorCount).toBe(0);
    const oversized = await page.request.post("/api/v1/imports/preview", { headers: { "x-csrf-token": auth.csrf }, data: { type: "CATERING", fileName: "oversized.csv", csv: "A".repeat(1_000_001) } });
    expect(oversized.status()).toBe(400);

    await page.getByRole("button", { name: /dashboard/i }).click();
    const flightRow = page.locator(".procurement-flights article").filter({ hasText: normalizedFlightNumber });
    await expect(flightRow).toContainText(serviceDate);
    await flightRow.locator("select").selectOption({ label: accounts.lead.name });
    await expect(page.getByText(/assignment updated/i)).toBeVisible();
    const flight = await db.flight.findFirstOrThrow({ where: { flightNumber: normalizedFlightNumber } });
    await db.flight.update({ where: { id: flight.id }, data: { status: FlightStatus.COMPLETED } });

    await logout(page);
    await login(page, accounts.lead);
    await page.locator('aside.sidebar nav button[title="Flight Purser"]').click();
    await page.locator(".crew-list article").filter({ hasText: accounts.purser.name }).locator('input[type="radio"]').check();
    await page.getByRole("button", { name: /save purser assignment/i }).click();
    await expect(page.getByText(/flight purser assigned successfully/i)).toBeVisible();
    await page.getByRole("button", { name: /assign catering/i }).click();
    await page.getByRole("button", { name: /assign to flight/i }).click();

    await logout(page);
    await login(page, accounts.purser);
    await expect(page.locator(".flight-hero").getByText(normalizedFlightNumber, { exact: true })).toBeVisible();
    await expect(page.getByText("Overdue leftovers report", { exact: true })).toBeVisible();
    for (const sectorLabel of ["S1 KGL–NBO", "S2 NBO–KGL"]) {
      const sectorTab = page.getByRole("button", { name: new RegExp(sectorLabel) });
      await sectorTab.click();
      for (const cabin of ["Economy", "Business"]) {
        await page.getByRole("button", { name: cabin, exact: true }).click();
        await page.locator('input[aria-label^="Consumed"]').first().fill("1");
        await page.locator('input[aria-label^="Returned"]').first().fill("1");
      }
    }
    // Save every cabin offline, then change one server version to exercise the
    // visible conflict/reapply path rather than silently dropping a queued draft.
    await page.context().setOffline(true);
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(page.locator(".offline-drafts").getByText("Waiting to synchronize")).toHaveCount(4);
    const firstManifest = await db.manifest.findFirstOrThrow({ where: { flightId: flight.id } });
    await db.manifest.update({ where: { id: firstManifest.id }, data: { version: { increment: 1 } } });
    await page.context().setOffline(false);
    await expect(page.getByRole("button", { name: "Reapply my saved values" })).toBeVisible();
    await page.getByRole("button", { name: "Reapply my saved values" }).click();
    const retry = page.getByRole("button", { name: "Retry sync", exact: true });
    if (await retry.count()) await retry.first().click();
    await expect(page.locator(".offline-drafts")).toHaveCount(0);
    await page.getByRole("button", { name: /submit final report/i }).click();
    await expect(page.getByRole("dialog", { name: /review leftovers report/i })).toBeVisible();
    await expect(page.getByRole("dialog").getByText(/S2.*NBO.*KGL/).first()).toBeVisible();
    await expect(page.getByRole("dialog").getByText(/Totals by sector, cabin and unit/i)).toBeVisible();
    await page.getByRole("button", { name: /confirm and submit report/i }).click();
    await expect(page.getByRole("dialog").getByText(/notes are required/i)).toBeVisible();
    await page.getByRole("button", { name: /edit quantities/i }).click();
    await page.getByPlaceholder(/add any general service details/i).fill("E2E report notes");
    await page.getByRole("button", { name: /submit final report/i }).click();
    await expect(page.getByRole("dialog", { name: /review leftovers report/i })).toBeVisible();
    await page.getByRole("button", { name: /confirm and submit report/i }).click();
    await expect(page.getByText(/awaiting approval/i)).toBeVisible();

    await logout(page);
    await login(page, accounts.lead);
    await page.getByRole("button", { name: /flight reports/i }).click();
    await page.getByRole("button", { name: /review details/i }).click();
    await expect(page.getByText(/full leftovers report/i)).toBeVisible();
    await expect(page.getByText("E2E report notes")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByText(/Totals by sector, cabin and unit/i)).toBeVisible();
    await page.getByRole("button", { name: /forward to catering/i }).click();

    await page.setViewportSize({ width: 1280, height: 900 });
    await logout(page);
    await login(page, accounts.catering);
    await page.getByRole("button", { name: /reconciliation/i }).click();
    const reconciliation = page.locator(".approval").filter({ hasText: normalizedFlightNumber });
    const csvDownload = page.waitForEvent("download");
    await reconciliation.getByRole("button", { name: "CSV" }).click();
    const csvPath = await (await csvDownload).path();
    expect(csvPath).toBeTruthy();
    const csv = await fs.readFile(csvPath!, "utf8");
    expect(csv).toContain("record_type");
    expect(csv.split("\r\n").filter((row) => row.startsWith("LINE,")).length).toBe(4);
    expect(csv).toContain("E2E report notes");
    const pdfDownload = page.waitForEvent("download");
    await reconciliation.getByRole("button", { name: "PDF" }).click();
    const pdf = await (await pdfDownload).createReadStream();
    expect(pdf).toBeTruthy();
    const pdfBytes: Buffer[] = [];
    for await (const chunk of pdf!) pdfBytes.push(Buffer.from(chunk));
    expect(Buffer.concat(pdfBytes).subarray(0, 5).toString()).toBe("%PDF-");
    await reconciliation.getByRole("button", { name: /approve & post ledger/i }).click();
    await expect(page.getByText(/ledger posted/i)).toBeVisible();
    const item = await db.catalogItem.findUniqueOrThrow({ where: { sku } });
    const movements = await db.stockMovement.count({ where: { flightId: flight.id, itemId: item.id } });
    expect(movements).toBe(12);
  });
});
