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
  await page.getByRole("button", { name: "Love it" }).click();
  await expect(page.getByTestId("super-note")).toContainText("saved to your favourites");
  expect(await prefs(page)).toEqual([expect.objectContaining({ dishId: first, kind: "favourite" })]);

  const second = await cardId(page);
  await page.getByRole("button", { name: "Not for a while" }).click();
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
  await expect(page.getByRole("button", { name: "Love it" })).toHaveCount(0);
  await page.keyboard.press("ArrowUp");
  expect(await prefs(page)).toEqual([]);
});

async function drag(page: Page, dx: number, dy: number) {
  const box = (await page.getByTestId("food-card").boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

test("swipe up = Love it, swipe down = Not for a while (solo)", async ({ page }) => {
  await startSolo(page);
  const first = await cardId(page);
  await drag(page, 0, -200);
  await expect(page.getByTestId("super-note")).toContainText("saved to your favourites");
  const second = await cardId(page);
  expect(second).not.toBe(first);
  await drag(page, 10, 200);
  await expect(page.getByTestId("super-note")).toContainText("hidden for 30 days");
  expect((await prefs(page)).map((p) => [p.dishId, p.kind])).toEqual(
    expect.arrayContaining([
      [first, "favourite"],
      [second, "snooze"],
    ]),
  );
});

test("the round buttons stay put when a note appears", async ({ page }) => {
  await startSolo(page);
  const bar = page.getByTestId("action-bar");
  const before = (await bar.boundingBox())!;
  await page.getByRole("button", { name: "Not for a while" }).click();
  await expect(page.getByTestId("super-note")).toBeVisible();
  const after = (await bar.boundingBox())!;
  expect(after.y).toBe(before.y);
  // Swipes still work on the part of the card under the note.
  const note = (await page.getByTestId("super-note").boundingBox())!;
  const id = await cardId(page);
  await page.mouse.move(note.x + 20, note.y + note.height / 2);
  await page.mouse.down();
  await page.mouse.move(note.x + 120, note.y + note.height / 2, { steps: 4 });
  await page.mouse.move(note.x + 240, note.y + note.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId("food-card")).not.toHaveAttribute("data-dish-id", id as string);
});

test("the swipe tip shows once per device", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.removeItem("fd.ui.tips.v1"));
  await startSolo(page);
  await expect(page.getByTestId("swipe-tip")).toContainText("Swipe up to save a favourite");
  await page.getByRole("button", { name: "Got it" }).click();
  await expect(page.getByTestId("swipe-tip")).toHaveCount(0);
  await startSolo(page);
  await expect(page.getByTestId("swipe-tip")).toHaveCount(0);
});

test("tapping the picture opens Details", async ({ page }) => {
  await startSolo(page);
  const box = (await page.getByTestId("dish-art").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 30);
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("Together Mode: vertical drags never save favourites or hides", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Decide together on this phone" }).click();
  const setup = page.getByTestId("together-setup");
  await setup.getByLabel("Your name").fill("Rave");
  await setup.getByLabel("Partner's name").fill("Sam");
  await setup.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Skip — start swiping" }).click();
  const id = await cardId(page);
  await drag(page, 0, -220);
  await expect(page.getByTestId("food-card")).toHaveAttribute("data-dish-id", id as string);
  expect(await prefs(page)).toEqual([]);
});

test("a dish with a photo shows its credit on the card and the full credit in Details", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("mood-summary").getByRole("button").first().click();
  const picker = page.getByTestId("mood-picker");
  await picker.getByRole("button", { name: "Filipino" }).click();
  await picker.getByRole("button", { name: "Soup", exact: true }).click();
  await picker.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Start discovering" }).click();
  await page.getByRole("button", { name: "Skip — start swiping" }).click();
  for (let i = 0; i < 10 && (await cardId(page)) !== "dish-bulalo"; i++) await page.getByRole("button", { name: "Not tonight" }).click();
  expect(await cardId(page)).toBe("dish-bulalo");
  const card = page.getByTestId("food-card");
  await expect(card.getByTestId("photo-credit")).toHaveText("Photo: Obsidian Soul · CC0");
  const img = card.locator("img");
  await expect(img).toHaveAttribute("src", /\/photos\/dish-bulalo\.jpg$/);
  expect(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  await card.getByRole("button", { name: "Details about Bulalo" }).click();
  const details = page.getByTestId("photo-details");
  await expect(details).toContainText("Photo by Obsidian Soul");
  await expect(details.getByRole("link", { name: "Wikimedia Commons" })).toHaveAttribute("href", /commons\.wikimedia\.org\/wiki\/File:/);
});
