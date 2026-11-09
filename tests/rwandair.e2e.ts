import { test, expect, type Page } from "@playwright/test";
import { PrismaClient, Role } from "../apps/api/node_modules/@prisma/client/default.js";
import { hash } from "../apps/api/node_modules/argon2/argon2.cjs";
import { cleanupRunFixtures } from "../apps/api/src/test-fixtures";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl || !/test|verification/i.test(new URL(testDatabaseUrl).pathname)) throw new Error("TEST_DATABASE_URL must identify an isolated test database");
const db = new PrismaClient({ datasourceUrl: testDatabaseUrl });
const password = "E2E-Only-Password-2026!";
const serviceDate = "2026-11-04";
const flightNumber = "WB9201";
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const sku = `E2E-RUN-MEAL-${suffix}`.toUpperCase();
const itemName = `E2E run meal ${suffix}`;
const accounts = {
  catering: { email: `catering-${suffix}@example.test`, name: `E2E Catering ${suffix}`, role: Role.PROCUREMENT },
  lead: { email: `cabin-${suffix}@example.test`, name: `E2E Cabin Services ${suffix}`, role: Role.LEAD },
  purser: { email: `purser-${suffix}@example.test`, name: `E2E Flight Purser ${suffix}`, role: Role.ATTENDANT },
  otherLead: { email: `other-cabin-${suffix}@example.test`, name: `E2E Other Lead ${suffix}`, role: Role.LEAD },
  otherPurser: { email: `other-purser-${suffix}@example.test`, name: `E2E Other Purser ${suffix}`, role: Role.ATTENDANT },
  director: { email: `director-${suffix}@example.test`, name: `E2E Director ${suffix}`, role: Role.DIRECTOR },
  admin: { email: `admin-${suffix}@example.test`, name: `E2E Admin ${suffix}`, role: Role.ADMIN },
};

async function login(page: Page, account: { email: string }) {
  await page.goto("/");
  await page.locator('input[autocomplete="username"]').fill(account.email);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.getByRole("button", { name: /sign in securely/i }).click();
  await expect(page.locator(".role-label")).toBeVisible();
}

async function logout(page: Page) {
  await page.getByRole("button", { name: /sign out/i }).click();
  await expect(page.locator('input[autocomplete="username"]')).toBeVisible();
}

async function csrfRequest(page: Page, path: string, method: "GET" | "PATCH", data?: unknown) {
  const auth = await (await page.request.get("/api/v1/auth/me")).json();
  return page.request.fetch(`/api/v1${path}`, { method, headers: { "x-csrf-token": auth.csrf }, data });
}

test.describe("RwandAir catering run workflow", () => {
  test.setTimeout(120_000);

  test.beforeAll(async () => {
    const passwordHash = await hash(password);
    await db.user.createMany({ data: Object.values(accounts).map((account) => ({ ...account, passwordHash })) });
    await db.catalogItem.create({
      data: {
        sku,
        nameEn: itemName,
        nameFr: `Repas ${suffix}`,
        category: "Hot meals",
        unit: "meal",
        reorderPoint: 0,
        prices: { create: { amountMinor: 1000, currency: "RWF", effectiveFrom: new Date("2026-01-01") } },
        lots: { create: { lotCode: `E2E-RUN-${suffix}`, quantity: 1000 } },
      },
    });
  });

  test.afterAll(async () => {
    try {
      const users = await db.user.findMany({ where: { email: { in: Object.values(accounts).map((account) => account.email) } }, select: { id: true } });
      const items = await db.catalogItem.findMany({ where: { sku }, select: { id: true } });
      await cleanupRunFixtures(db, users.map((user) => user.id), items.map((item) => item.id));
    } finally { await db.$disconnect(); }
  });

  test("imports a run, resolves concurrent edits, rejects stale previews and approves the report", async ({ page, browser }) => {
    await login(page, accounts.catering);
    await page.getByRole("button", { name: /upload data/i }).click();
    await expect(page.getByRole("heading", { name: "Create catering run" })).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({
      name: "run-e2e.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(`flight_number,service_date,item,loaded\n${flightNumber},${serviceDate},${itemName},12\n`),
    });
    await page.getByRole("button", { name: /preview and validate/i }).click();
    await expect(page.getByText("Ready to commit")).toBeVisible();
    await page.getByRole("button", { name: /commit import/i }).click();
    await expect(page.getByText(/import committed successfully/i)).toBeVisible();
    expect(await db.flight.count({ where: { flightNumber: `WB ${flightNumber.slice(2)}` } })).toBe(0);

    await page.getByRole("button", { name: /dashboard/i }).click();
    const runCard = page.locator(".catering-run-card").filter({ hasText: `WB ${flightNumber.slice(2)}` });
    await expect(runCard).toBeVisible();
    await runCard.getByLabel(/Cabin Services lead for/i).selectOption({ label: accounts.lead.name });
    await expect(page.getByText(/Cabin Services lead assigned to the catering run/i)).toBeVisible();
    const run = await db.cateringList.findUniqueOrThrow({ where: { flightNumber_serviceDate: { flightNumber: `WB ${flightNumber.slice(2)}`, serviceDate: new Date(`${serviceDate}T00:00:00.000Z`) } } });
    const lead = await db.user.findUniqueOrThrow({ where: { email: accounts.lead.email } });
    const otherPurser = await db.user.findUniqueOrThrow({ where: { email: accounts.otherPurser.email } });
    await logout(page);

    await login(page, accounts.otherLead);
    const forbiddenPurser = await csrfRequest(page, `/runs/${run.id}/purser`, "PATCH", { purserId: otherPurser.id });
    expect(forbiddenPurser.status()).toBe(403);
    await logout(page);

    await login(page, accounts.lead);
    await page.locator('aside.sidebar nav button[title="Catering runs"]').click();
    await expect(page.getByText("Assigned Flight Pursers")).toBeVisible();
    await page.getByLabel(/Add Flight Purser to/i).selectOption({ label: accounts.purser.name });
    await expect(page.getByText(/flight purser added to this catering run/i)).toBeVisible();
    await page.getByLabel(/Add Flight Purser to/i).selectOption({ label: accounts.otherPurser.name });
    await expect(page.getByText(accounts.otherPurser.name)).toBeVisible();
    await logout(page);

    await login(page, accounts.purser);
    await expect(page.getByRole("heading", { name: "My assigned catering runs" })).toBeVisible();
    await expect(page.getByText(`WB ${flightNumber.slice(2)}`).first()).toBeVisible();
    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await login(otherPage, accounts.otherPurser);
    await otherPage.locator(".purser-consumed-input").fill("6");
    await page.locator(".purser-consumed-input").fill("8");
    await page.getByRole("button", { name: /save consumption/i }).click();
    await expect(page.getByText(/returned quantities were calculated automatically/i)).toBeVisible();
    await otherPage.getByRole("button", { name: /save consumption/i }).click();
    await expect(otherPage.getByRole("region", { name: "Review shared draft changes" })).toBeVisible();
    await expect(otherPage.locator(".purser-consumed-input")).toHaveValue("6");
    await otherPage.getByLabel(/Resolve consumed for/).selectOption("server");
    await otherPage.getByRole("button", { name: "Apply reviewed changes" }).click();
    await expect(otherPage.locator(".purser-consumed-input")).toHaveValue("8");
    await otherPage.getByRole("button", { name: /save consumption/i }).click();
    await expect(otherPage.getByText(/returned quantities were calculated automatically/i)).toBeVisible();
    await otherContext.close();
    await logout(page);

    await login(page, accounts.otherPurser);
    await expect(page.getByRole("heading", { name: "My assigned catering runs" })).toBeVisible();
    await expect(page.getByText(`WB ${flightNumber.slice(2)}`).first()).toBeVisible();
    await logout(page);

    await login(page, accounts.lead);
    await expect(page.getByRole("button", { name: /preview report/i })).toBeEnabled();
    await page.getByRole("button", { name: /preview report/i }).click();
    await expect(page.getByText(/report preview/i)).toBeVisible();
    const editingContext = await browser.newContext();
    const editingPage = await editingContext.newPage();
    await login(editingPage, accounts.otherPurser);
    await editingPage.locator(".purser-consumed-input").fill("7");
    await editingPage.getByRole("button", { name: /save consumption/i }).click();
    await expect(editingPage.getByText(/returned quantities were calculated automatically/i)).toBeVisible();
    await editingContext.close();
    await page.getByRole("button", { name: /send to catering/i }).click();
    await page.getByRole("button", { name: "Send report", exact: true }).click();
    await expect(page.getByText(/consumption changed since your preview/i)).toBeVisible();
    expect(await db.cateringRunReport.count({ where: { cateringListId: run.id } })).toBe(0);
    await page.getByRole("button", { name: /preview report/i }).click();
    await page.getByRole("button", { name: /send to catering/i }).click();
    await expect(page.getByRole("dialog", { name: "Send this report to Catering?" })).toBeVisible();
    await page.getByRole("button", { name: "Send report", exact: true }).click();
    await expect(page.getByText(/report sent to catering/i)).toBeVisible();
    await logout(page);

    await login(page, accounts.catering);
    await page.getByRole("button", { name: /reconciliation/i }).click();
    const reconciliation = page.locator(".approval").filter({ hasText: `WB ${flightNumber.slice(2)}` });
    await expect(reconciliation).toBeVisible();
    await reconciliation.getByRole("button", { name: /approve & post ledger/i }).click();
    await expect(page.getByText(/ledger posted/i)).toBeVisible();
    const report = await db.cateringRunReport.findFirstOrThrow({ where: { cateringListId: run.id } });
    expect(report.status).toBe("APPROVED");
    expect(await db.stockMovement.count({ where: { runId: run.id } })).toBe(2);
    expect(lead.id).toBeTruthy();
    await logout(page);

    await login(page, accounts.director);
    await expect(page.getByText(/auto-returned/i)).toBeVisible();
    await logout(page);

    await login(page, accounts.admin);
    await expect(page.getByText("Approved runs")).toBeVisible();
  });
});
