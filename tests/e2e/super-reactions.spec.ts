import { expect, test, type Page } from "@playwright/test";
import dishes from "../../src/catalog/dishes.json" with { type: "json" };

/** "Love it" / "Not for a while" / "Never show again" (owner request 2026-11-07). */

const prefs = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("fd.strongprefs.v1") ?? "[]") as Array<{ dishId: string; kind: string; until?: string }>);
const cardId = (page: Page) => page.getByTestId("food-card").getAttribute("data-dish-id");

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

async function startSolo(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Start discovering" }).click();
  await page.getByRole("button", { name: "Skip — start swiping" }).click();
  await expect(page.getByTestId("food-card")).toBeVisible();
}

test("Love it saves a favourite; Not for a while hides for 30 days; Never show again; Undo restores", async ({ page }) => {
  await startSolo(page);
  const first = await cardId(page);
  await page.getByRole("button", { name: "★ Love it" }).click();
  await expect(page.getByTestId("super-note")).toContainText("saved to your favourites");
  expect(await prefs(page)).toEqual([expect.objectContaining({ dishId: first, kind: "favourite" })]);

  const second = await cardId(page);
  await page.getByRole("button", { name: "⏸ Not for a while" }).click();
  await expect(page.getByTestId("super-note")).toContainText("hidden for 30 days");
  const snoozed = (await prefs(page)).find((p) => p.dishId === second)!;
  expect(snoozed.kind).toBe("snooze");
  const days = (Date.parse(snoozed.until!) - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(29.9);
  expect(days).toBeLessThan(30.1);

  await page.getByRole("button", { name: "Never show again" }).click();
  await expect(page.getByTestId("super-note")).toContainText("won't be shown again");
  expect((await prefs(page)).find((p) => p.dishId === second)?.kind).toBe("never");

  // Undo takes back the strong reaction and the preference it created.
  await page.getByRole("button", { name: "Undo last reaction" }).click();
  expect(await cardId(page)).toBe(second);
  expect((await prefs(page)).map((p) => p.dishId)).toEqual([first]);

  // Recorded as explicit-strength reactions in the session record.
  const rec = await page.evaluate(() => JSON.parse(localStorage.getItem("fd.eval.sessions.v1") ?? "[]")[0]);
  expect(rec.exposures[0].reaction).toBe("super_yes");
  expect(rec.exposures[1].undoneReactions).toEqual(["super_no"]);

  // Your data lists it and lets you remove it.
  await page.goto("/data");
  const section = page.getByTestId("strong-prefs");
  await expect(section.getByRole("list", { name: "Favourites" })).toContainText("★");
  await section.getByRole("button", { name: "Remove" }).click();
  await expect(section).toContainText("None yet");
  expect(await prefs(page)).toEqual([]);
});

test("hidden dishes never appear as cards in later sessions", async ({ page }) => {
  const filipino = (dishes as { dishes: Array<{ id: string; cuisine: string }> }).dishes.filter((d) => d.cuisine === "filipino").map((d) => d.id);
  await page.addInitScript((ids) => {
    if (localStorage.getItem("fd.seeded")) return;
    localStorage.setItem("fd.seeded", "1");
    const at = new Date().toISOString();
    localStorage.setItem("fd.strongprefs.v1", JSON.stringify(ids.map((dishId) => ({ dishId, kind: "never", at }))));
  }, filipino);
  await startSolo(page);
  for (let i = 0; i < 6; i++) {
    expect(filipino).not.toContain(await cardId(page));
    await page.getByRole("button", { name: "Not tonight" }).click();
    if (await page.getByTestId("results").isVisible()) break;
  }
});

test("Together Mode has no Love it / Not for a while", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Decide together on this phone" }).click();
  const setup = page.getByTestId("together-setup");
  await setup.getByLabel("Your name").fill("Rave");
  await setup.getByLabel("Partner's name").fill("Sam");
  await setup.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Skip — start swiping" }).click();
  await expect(page.getByTestId("food-card")).toBeVisible();
  await expect(page.getByRole("button", { name: "★ Love it" })).toHaveCount(0);
  await page.keyboard.press("ArrowUp");
  expect(await prefs(page)).toEqual([]);
});
