import { expect, test, type Page } from "@playwright/test";

/** Browser tests for the M1 solo prototype (ENG-016/017/018). Reduced motion makes reactions instant. */

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

const card = (page: Page) => page.getByTestId("food-card");
const dishOnCard = (page: Page) => card(page).getAttribute("data-dish-id");

async function start(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Start discovering" }).click();
  await page.getByRole("button", { name: "Skip — start swiping" }).click();
  await expect(card(page)).toBeVisible();
}

async function evalSessions(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("fd.eval.sessions.v1") ?? "[]"));
}

test("AT-001: first-time guest reaches a food card without registration", async ({ page }) => {
  await start(page);
  await expect(card(page).getByRole("heading")).not.toBeEmpty();
  await expect(card(page).getByText("Illustration · no photo yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "Not tonight" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sounds good" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo last reaction" })).toBeDisabled();
});

test("AT-003/AT-006: buttons react, undo restores the previous card, re-reacting is deterministic", async ({ page }) => {
  await start(page);
  const first = await dishOnCard(page);
  await page.getByRole("button", { name: "Sounds good" }).click();
  const second = await dishOnCard(page);
  expect(second).not.toBe(first);
  await page.getByRole("button", { name: "Undo last reaction" }).click();
  await expect(card(page)).toHaveAttribute("data-dish-id", first as string);
  await expect(page.getByTestId("live-region")).toContainText("Undone");
  await page.getByRole("button", { name: "Sounds good" }).click();
  await expect(card(page)).toHaveAttribute("data-dish-id", second as string);
  const [rec] = await evalSessions(page);
  expect(rec.exposures[0].undoneReactions).toEqual(["yes"]);
  expect(rec.exposures[0].reaction).toBe("yes");
});

test("AT-004: complete keyboard-only flow, and selecting is not eating (AT-020)", async ({ page }) => {
  await page.goto("/");
  const startBtn = page.getByRole("button", { name: "Start discovering" });
  await startBtn.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Skip — start swiping" }).focus();
  await page.keyboard.press("Enter");
  await expect(card(page)).toBeVisible();
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press(i % 3 === 0 ? "ArrowLeft" : "ArrowRight");
  }
  await expect(page.getByTestId("results")).toBeVisible(); // round of ~10 ends → results
  const choose = page.getByRole("button", { name: /^Choose / }).first();
  await choose.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("picked")).toBeVisible();
  const meals = await page.evaluate(() => localStorage.getItem("fd.meals.v1"));
  expect(meals).toBeNull();
  const [rec] = await evalSessions(page);
  expect(rec.events.map((e: { type: string }) => e.type)).toEqual(["dish_selected"]);
});

test("swipe gesture: dragging right means 'Sounds good'", async ({ page }) => {
  await start(page);
  const first = await dishOnCard(page);
  const box = (await card(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 3, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 3, { steps: 4 });
  await page.mouse.up();
  await expect(card(page)).not.toHaveAttribute("data-dish-id", first as string);
  const [rec] = await evalSessions(page);
  expect(rec.exposures[0]).toMatchObject({ dishId: first, reaction: "yes" });
});

test("a short drag snaps back without reacting", async ({ page }) => {
  await start(page);
  const first = await dishOnCard(page);
  const box = (await card(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 40, box.y + 100, { steps: 3 });
  await page.mouse.up();
  await expect(card(page)).toHaveAttribute("data-dish-id", first as string);
});

test("AT-007: early results are labelled tentative", async ({ page }) => {
  await start(page);
  await expect(page.getByRole("button", { name: "See picks" })).toBeDisabled();
  await page.getByRole("button", { name: "Sounds good" }).click();
  await page.getByRole("button", { name: "See picks" }).click();
  await expect(page.getByRole("heading", { name: "A few early ideas" })).toBeVisible();
  await expect(page.getByText(/Based on only 1 reaction/)).toBeVisible();
  await expect(page.getByText(/Early pick/).first()).toBeVisible();
  await expect(page.getByTestId("results")).not.toContainText("%");
});

test("AT-008 / ALG-013: rejecting everything gives an honest no-match and discovery can continue", async ({ page }) => {
  await start(page);
  for (let i = 0; i < 10; i++) await page.getByRole("button", { name: "Not tonight" }).click();
  await expect(page.getByRole("heading", { name: "No strong match yet" })).toBeVisible();
  await expect(page.getByTestId("recommendation")).toHaveCount(0);
  await page.getByRole("button", { name: "Keep discovering" }).click();
  await expect(card(page)).toBeVisible();
  await expect(page.getByTestId("progress")).toContainText("of 20");
});

test("details open without casting a vote", async ({ page }) => {
  await start(page);
  const first = await dishOnCard(page);
  await card(page).getByRole("button", { name: /Details about/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("not any specific recipe or restaurant");
  await page.keyboard.press("ArrowRight"); // must not vote while dialog is open
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(card(page)).toHaveAttribute("data-dish-id", first as string);
  const [rec] = await evalSessions(page);
  expect(rec.exposures[0].reaction).toBeNull();
});

test("AT-009/AT-010: shellfish avoidance hides confirmed shellfish dishes and never claims safety", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Dietary restrictions/ }).click();
  await page.getByRole("checkbox", { name: /Shellfish/ }).check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: /1 avoided/ })).toBeVisible();
  await page.getByRole("button", { name: "Start discovering" }).click();
  await page.getByRole("button", { name: "Skip — start swiping" }).click();
  await expect(card(page).getByTestId("safety-note")).toBeVisible();
  await expect(card(page).getByTestId("safety-note")).toContainText(/check before ordering/);
  const seen: string[] = [];
  for (let round = 0; round < 6; round++) {
    for (let i = 0; i < 10; i++) {
      if (!(await card(page).isVisible())) break;
      seen.push((await dishOnCard(page)) as string);
      await page.getByRole("button", { name: "Not tonight" }).click();
    }
    const keep = page.getByRole("button", { name: "Keep discovering" });
    if (await keep.isVisible()) await keep.click();
    else break;
  }
  expect(seen.length).toBeGreaterThan(40);
  for (const shrimp of ["dish-shrimp-sinigang", "dish-shrimp-tempura", "dish-pad-thai", "dish-tom-yum-goong"]) expect(seen).not.toContain(shrimp);
  // privacy: the evaluation record says constraints were active but not which ones (AT-033)
  const raw = await page.evaluate(() => localStorage.getItem("fd.eval.sessions.v1"));
  expect(raw).toContain('"hardConstraintsActive":true');
  expect(raw).not.toContain("shellfish");
});

test("outcome: confirm a different dish, rate it, and see it in the lab", async ({ page }) => {
  await start(page);
  await page.getByRole("button", { name: "Sounds good" }).click();
  await page.getByRole("button", { name: "See picks" }).click();
  await page.getByRole("button", { name: /^Choose / }).first().click();
  await page.getByRole("button", { name: "I ate something else" }).click();
  await page.getByLabel("Search dishes").fill("Bulalo");
  await page.getByRole("button", { name: "Bulalo", exact: true }).click();
  await page.getByRole("button", { name: /Loved it/ }).click();
  await expect(page.getByText("Noted — thank you.")).toBeVisible();
  const [rec] = await evalSessions(page);
  const types = rec.events.map((e: { type: string }) => e.type);
  expect(types).toEqual(["dish_selected", "meal_consumption_confirmed", "satisfaction_recorded"]);
  expect(rec.events[1]).toMatchObject({ dishId: "dish-bulalo", matchesSelection: false });

  await page.goto("/lab");
  await expect(page.getByText("Prototype evaluation · internal testing tool")).toBeVisible();
  await expect(page.getByText(/Bulalo · /)).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export JSON" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^food-eval-.*\.json$/);
});

test("R-028: no horizontal page scroll at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  for (const path of ["/", "/lab/", "/data/"]) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
  await page.goto("/");
  await page.getByRole("button", { name: "Start discovering" }).click();
  await page.getByRole("button", { name: "Skip — start swiping" }).click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.goto("/data/");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
