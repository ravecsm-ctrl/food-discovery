import { expect, test } from "@playwright/test";

/** Library step 2 — describe a food that isn't in the dish list (PRRD §9.4, R-015, R-012). */

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("log an unlisted food with a short description; it counts toward variety and can be edited later", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Start discovering" }).click();
  await page.getByPlaceholder("e.g. Adobo, ramen, pizza").fill("kebab sa kanto");
  await page.getByRole("button", { name: /Use “kebab sa kanto”/ }).click();

  const describe = page.getByTestId("describe-dish");
  await expect(describe).toContainText("isn't in our dish list");
  await describe.getByRole("button", { name: "Middle Eastern" }).click();
  await describe.getByRole("button", { name: "Beef" }).click();
  await describe.getByRole("button", { name: "Grilled", exact: true }).click();
  await describe.getByRole("button", { name: "Wrap" }).click();
  await describe.getByRole("button", { name: "Garlicky" }).click();
  await expect(describe).toContainText("Middle Eastern · grilled · beef · wrap · garlicky");
  await describe.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText(/Your dish: .*counts toward variety/)).toBeVisible();
  await page.getByRole("button", { name: "Last night" }).click();
  await expect(page.getByTestId("recent-meal").filter({ hasText: "kebab sa kanto" })).toBeVisible();

  const [m] = await page.evaluate(() => JSON.parse(localStorage.getItem("fd.meals.v1") ?? "[]"));
  expect(m).toMatchObject({ dishId: null, unrecognizedName: "kebab sa kanto", ownDish: { cuisine: "middle_eastern", mains: ["beef"], method: "grilled", type: "wraps", flavors: ["flavor:garlicky"] } });

  // Reuse: typing it again offers "your dish" instead of describing twice.
  await page.getByPlaceholder("e.g. Adobo, ramen, pizza").fill("kebab sa");
  await expect(page.getByRole("list", { name: "Your own dishes" })).toContainText("kebab sa kanto");

  // Your data: shown with its description; editable.
  await page.goto("/data");
  const unlisted = page.getByTestId("unlisted-foods");
  await expect(unlisted).toContainText("kebab sa kanto");
  await expect(unlisted).toContainText("Middle Eastern · grilled · beef · wrap · garlicky");
  await unlisted.getByRole("button", { name: "Edit description of kebab sa kanto" }).click();
  const sheet = page.getByTestId("describe-dish");
  await sheet.getByRole("button", { name: "Spicy" }).click();
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(unlisted).toContainText("spicy");
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem("fd.meals.v1") ?? "[]")[0].ownDish.flavors);
  expect(after).toEqual(["flavor:garlicky", "flavor:spicy"]);
});

test("skipping the description still logs the meal by name only", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Start discovering" }).click();
  await page.getByPlaceholder("e.g. Adobo, ramen, pizza").fill("Lola's stew");
  await page.getByRole("button", { name: /Use “Lola's stew”/ }).click();
  await page.getByRole("button", { name: "Skip — just log the name" }).click();
  await page.getByRole("button", { name: "Last night" }).click();
  const [m] = await page.evaluate(() => JSON.parse(localStorage.getItem("fd.meals.v1") ?? "[]"));
  expect(m.ownDish ?? null).toBeNull();
  expect(m.unrecognizedName).toBe("Lola's stew");
});
