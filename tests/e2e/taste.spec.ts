import { expect, test } from "@playwright/test";

/** Library step 3 — mood focus, meal ratings and the taste summary (R-008, R-016). */

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("'In the mood for…' narrows tonight's cards and says so", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("mood-summary").getByRole("button").first().click();
  const picker = page.getByTestId("mood-picker");
  await picker.getByRole("button", { name: "Japanese" }).click();
  await picker.getByRole("button", { name: "Noodles", exact: true }).click();
  await expect(picker.getByTestId("mood-count")).toHaveText(/^\d+ dish(es)? match\.$/);
  await picker.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("mood-summary")).toContainText("Japanese · Noodles");

  await page.getByRole("button", { name: "Start discovering" }).click();
  await page.getByRole("button", { name: "Skip — start swiping" }).click();
  const JAPANESE_NOODLES = ["dish-tonkotsu-ramen", "dish-shoyu-ramen", "dish-spicy-miso-ramen", "dish-tempura-udon"];
  for (let i = 0; i < 3; i++) {
    const id = await page.getByTestId("food-card").getAttribute("data-dish-id");
    expect(JAPANESE_NOODLES).toContain(id);
    await page.getByRole("button", { name: i === 0 ? "Sounds good" : "Not tonight" }).click();
    if (await page.getByTestId("results").isVisible()) break;
  }
  if (!(await page.getByTestId("results").isVisible())) await page.getByRole("button", { name: "See picks" }).click();
  await expect(page.getByTestId("results")).toContainText("Showing only: Japanese · Noodles.");
  await expect(page.getByTestId("results")).not.toContainText("hidden because of your dietary restrictions");
});

test("rating meals builds 'Your taste so far' — from ratings only", async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem("fd.seeded")) return;
    localStorage.setItem("fd.seeded", "1");
    const at = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    const m = (id: string, dishId: string, h: number) => ({ id, dishId, consumedAt: at(h), confirmed: true, source: "manual" });
    localStorage.setItem("fd.meals.v1", JSON.stringify([m("m1", "dish-chicken-pho", 30), m("m2", "dish-bulalo", 60), m("m3", "dish-tonkotsu-ramen", 90)]));
  });
  await page.goto("/data");
  const taste = page.getByTestId("taste-profile");
  await expect(taste).toContainText("Rate a few meals");

  for (const name of ["Chicken Pho", "Bulalo", "Tonkotsu Ramen"]) {
    await page.getByRole("group", { name: `Rate ${name}` }).getByRole("button", { name: "5 stars" }).click();
  }
  await expect(taste).toContainText("You tend to enjoy:");
  await expect(taste).toContainText("brothy");
  await expect(taste).toContainText("From 3 rated meals");
  const ratings = await page.evaluate(() => JSON.parse(localStorage.getItem("fd.meals.v1") ?? "[]").map((x: { rating?: number }) => x.rating));
  expect(ratings).toEqual([5, 5, 5]);

  // Tapping the same star again clears it.
  await page.getByRole("group", { name: "Rate Bulalo" }).getByRole("button", { name: "5 stars" }).click();
  await expect(taste).toContainText("From 2 rated meals");
});
