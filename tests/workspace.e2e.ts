import { test, expect, type Page } from "@playwright/test";

const names = ["Akagera still water", "Chicken brochette meal", "Fresh fruit selection", "Rwandan coffee", "Vegetarian meal", "Orange juice"];
const lines = Array.from({ length: 36 }, (_, index) => ({ id: `item-${index}`, loaded: 120, consumed: index % 3 === 0 ? 80 : 0, returned: 120, spoiled: 0, discarded: 0, remarks: "", item: { nameEn: `${names[index % names.length]} ${String(index + 1).padStart(2, "0")}`, unit: index % 2 ? "meal" : "bottle", sku: `ITEM-${index}` } }));
const staff = [{ id: "purser-1", name: "Uwase Keza", email: "keza@example.test" }, { id: "purser-2", name: "Eric Mugisha", email: "eric@example.test" }];
const runs = Array.from({ length: 105 }, (_, index) => ({
  id: `run-${index}`, name: `WB ${700 + index} · 2026-11-07`, flightNumber: `WB ${700 + index}`, serviceDate: "2026-11-07", status: "READY", version: 1, reportingStartedAt: "2026-11-07T09:00:00Z",
  lines, lead: index < 2 ? null : { id: "lead", name: "Aline Mukamana" }, pursers: staff, createdBy: { name: "Catering team" },
  report: index > 4 ? { id: `report-${index}`, status: "APPROVED", version: 1, submittedAt: "2026-11-07T10:00:00Z" } : null,
}));
const summary = { forwarded: 4, approved: 100, loaded: 12000, consumed: 9000, returned: 3000, consumptionRate: 75, returnRate: 25, recent: [] };

async function workspace(page: Page, role: string) {
  let reportSends = 0;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    let result: unknown = [];
    if (path === "/auth/me") result = { user: { id: "user", name: "Aline Mukamana", email: "aline@example.test", role }, csrf: "test-csrf" };
    else if (path === "/runs") result = runs;
    else if (path === "/lead/attendants" || path === "/procurement/leads") result = staff;
    else if (path.endsWith("/draft")) result = { version: 2 };
    else if (path.includes("/report")) {
      if (route.request().method() === "POST") reportSends++;
      const id = path.split("/")[2];
      const run = runs.find((run) => run.id === id)!;
      result = { id: null, version: 1, runVersion: run.version, status: "DRAFT", flight: { id, flightNumber: run.flightNumber, serviceDate: run.serviceDate, sectors: [], aircraft: "", status: "READY" }, purser: staff[0], pursers: staff, lines: lines.map((line) => ({ ...line, item: line.item.nameEn, sku: line.item.sku, unit: line.item.unit, sector: 1, cabin: "ECONOMY", origin: "", destination: "", returned: line.loaded - line.consumed, unexplained: 0 })) };
    } else if (path === "/notifications") result = [{ id: "notice", title: "WB 700: catering run assigned", body: "Your team is ready to record consumption.", kind: "RUN_ASSIGNED", actionPath: role === "ATTENDANT" ? "my-runs" : "operations", readAt: null, createdAt: "2026-11-07T10:00:00Z" }];
    else if (path === "/procurement/waste") result = { totalMinor: 0, byReason: [], byCategory: [] };
    else if (path === "/dashboard/operations") result = summary;
    else if (path === "/dashboard/director") result = { mtdSpendMinor: 2450000, wasteRate: 2, annualizedSavingsMinor: 125000, recoverablePct: 25, approvedReports: 100, monthlyTrend: [{ month: "2026-09", amountMinor: 1200000 }, { month: "2026-10", amountMinor: 1800000 }, { month: "2026-11", amountMinor: 2450000 }], categoryBreakdown: [{ category: "Meals", amountMinor: 2000000 }, { category: "Beverages", amountMinor: 450000 }] };
    else if (path === "/admin/users") result = staff.map((user) => ({ ...user, role: "ATTENDANT", active: true, passwordChangedAt: "2026-11-01" }));
    await route.fulfill({ json: result });
  });
  await page.goto("/");
  await expect(page.locator(".page-title")).toBeVisible();
  return () => reportSends;
}

async function noPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
}

test("Purser: long lists, unsaved protection and mobile consumption", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await workspace(page, "ATTENDANT");
  await expect(page.locator(".purser-item-table tbody tr")).toHaveCount(36);
  await page.locator(".purser-consumed-input").first().fill("42");
  await page.getByRole("button", { name: "Run history", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Leave your unsaved changes?" })).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.locator(".purser-consumed-input").first()).toHaveValue("42");
  await page.locator(".purser-run-item").nth(1).click();
  await expect(page.getByRole("dialog", { name: "You have unsaved consumption" })).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await page.getByRole("button", { name: "Save consumption", exact: true }).click();
  await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThan(1600);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "test-results/polish-purser-desktop.png", fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.locator(".app-shell")).toHaveClass(/sidebar-collapsed/);
  await page.setViewportSize({ width: 390, height: 844 });
  await noPageOverflow(page);
  await expect(page.locator(".purser-item-table")).toHaveCSS("display", "block");
  await page.getByLabel("Search catering items").fill("Chicken");
  await expect(page.locator(".purser-item-table tbody tr")).toHaveCount(6);
  await page.getByRole("button", { name: /Add remark for/ }).first().click();
  await expect(page.locator(".purser-remark-input").first()).toBeVisible();
  await page.screenshot({ path: "test-results/polish-purser-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close navigation" }).click();
  await page.getByRole("button", { name: "Run history", exact: true }).click();
  await expect(page.locator(".purser-run-item")).toHaveCount(100);
  await page.getByLabel("Filter assigned runs by date").fill("2026-10-01");
  await expect(page.getByText("No runs match this search.")).toBeVisible();
});

test("Lead: workspace sections, preview and deliberate report sending", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const reportSends = await workspace(page, "LEAD");
  await expect(page.locator(".run-picker-item")).toHaveCount(5);
  await page.getByRole("button", { name: "Consumption", exact: true }).click();
  await expect(page.locator(".lead-consumption-list article")).toHaveCount(36);
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Preview report", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Report preview" })).toBeVisible();
  await page.screenshot({ path: "test-results/polish-lead-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Send to Catering →", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Send this report to Catering?" })).toBeVisible();
  await page.keyboard.press("Escape");
  expect(reportSends()).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await noPageOverflow(page);
  await page.getByRole("button", { name: "Open full preview ↗" }).click();
  await expect(page.getByRole("dialog", { name: "Full report preview" })).toBeVisible();
  await page.screenshot({ path: "test-results/polish-report-mobile.png", animations: "disabled" });
  await page.getByRole("button", { name: "Close report" }).click();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.locator(".run-picker-item")).toHaveCount(100);
  await page.getByRole("button", { name: "Active", exact: true }).click();
  await page.getByRole("button", { name: "Preview report", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Full report preview" })).toBeVisible();
  await page.keyboard.press("Escape");
});

for (const role of ["PROCUREMENT", "DIRECTOR", "ADMIN"]) {
  test(`${role}: responsive dashboard and notifications`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await workspace(page, role);
    await page.screenshot({ path: `test-results/polish-${role.toLowerCase()}-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await noPageOverflow(page);
    await page.getByRole("button", { name: "1 unread notifications" }).click();
    await expect(page.getByRole("region", { name: "Notifications" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("region", { name: "Notifications" })).not.toBeVisible();
    await page.screenshot({ path: `test-results/polish-${role.toLowerCase()}-mobile.png`, fullPage: true });
    for (const width of [320, 768, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      await noPageOverflow(page);
    }
  });
}
