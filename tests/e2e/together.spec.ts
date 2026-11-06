import { expect, test } from "@playwright/test";

/** M3 step 1 — Together Mode on one phone (PRRD J-03 · AT-013, AT-014 · R-011, R-017, R-022, R-023). */

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("two people swipe on one phone, disagree once, and confirm a joint pick", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Decide together on this phone" }).click();
  const setup = page.getByTestId("together-setup");
  await setup.getByLabel("Your name").fill("Rave");
  await setup.getByLabel("Partner's name").fill("Sam");
  await setup.getByRole("button", { name: "Shellfish" }).click();
  await expect(setup.getByRole("button", { name: "Shellfish" })).toHaveAttribute("aria-pressed", "true");
  await setup.getByRole("button", { name: "Next" }).click();

  // "What have you two eaten recently?" — attributed, session-only.
  const meals = page.getByTestId("together-meals");
  await expect(meals.getByRole("heading", { name: "What have you two eaten recently?" })).toBeVisible();
  await meals.getByPlaceholder("e.g. Adobo, ramen, pizza").fill("tonkotsu");
  await meals.getByRole("button", { name: "Tonkotsu Ramen", exact: true }).click();
  await meals.getByRole("group", { name: "Who had it" }).getByRole("button", { name: "Sam" }).click();
  await meals.getByRole("button", { name: "Last night" }).click();
  await meals.getByPlaceholder("e.g. Adobo, ramen, pizza").fill("adobo");
  await meals.getByRole("button", { name: "Chicken Adobo", exact: true }).click();
  await meals.getByRole("group", { name: "Who had it" }).getByRole("button", { name: "Both" }).click();
  await meals.getByRole("button", { name: "Yesterday lunch" }).click();
  await expect(meals.getByTestId("together-meal")).toHaveCount(2);
  await expect(meals.getByTestId("together-meal").first()).toContainText("Sam");
  await meals.getByRole("button", { name: "Start swiping" }).click();

  const card = page.getByTestId("food-card");
  await expect(card).toBeVisible();
  const firstCard = await card.getAttribute("data-dish-id");
  expect(["dish-tonkotsu-ramen", "dish-chicken-adobo"]).not.toContain(firstCard);
  await expect(page.getByRole("button", { name: "We like it" })).toBeVisible();

  // AT-013 shared vote, AT-014 disagreement with attribution.
  await page.getByRole("button", { name: "We like it" }).click();
  const disagreed = await card.getAttribute("data-dish-id");
  await page.getByRole("button", { name: "We disagree on this one" }).click();
  await page.getByTestId("disagree-panel").getByRole("button", { name: "Only Sam" }).click();
  await page.getByRole("button", { name: "Not for us" }).click();
  await page.getByRole("button", { name: "We like it" }).click();

  // Undo removes the whole last action; redo it.
  await page.getByRole("button", { name: "Undo last reaction" }).click();
  await page.getByRole("button", { name: "We like it" }).click();

  await page.getByRole("button", { name: "See picks" }).click();
  const results = page.getByTestId("results");
  await expect(results.getByRole("heading", { name: "Picks for Rave & Sam" })).toBeVisible();
  await expect(results).toContainText("Ranked so neither of you gets something you didn't want");
  await expect(results).toContainText(/you both said yes/i);
  await expect(results).not.toContainText(/both liked|Rave and Sam both/i);

  // Shellfish (partner's, this session only) is a hard exclusion: nothing confirmed-shellfish is offered.
  const picks = await results.getByTestId("recommendation").allInnerTexts();
  expect(picks.join(" ")).not.toMatch(/Har Gow|Shrimp Fried Rice|Salted Egg Shrimp/);

  await results.getByRole("button", { name: /^Pick .* together$/ }).first().click();
  const confirm = page.getByTestId("joint-confirm");
  await expect(confirm).toContainText("for Rave and Sam");
  await confirm.getByRole("button", { name: "Yes, it's our pick" }).click();
  await expect(page.getByTestId("partner-note")).toContainText("Sam's isn't saved");

  const rec = await page.evaluate(() => JSON.parse(localStorage.getItem("fd.eval.sessions.v1") ?? "[]").at(-1));
  expect(rec.mode).toBe("together");
  expect(rec.events.map((e: { type: string }) => e.type)).toEqual(["joint_decision_confirmed"]);
  const reactions = rec.exposures.map((e: { dishId: string; reaction: string | null }) => [e.dishId, e.reaction]);
  expect(reactions).toContainEqual([disagreed, "b"]);
  expect(reactions.filter(([, r]: [string, string | null]) => r !== null)).toHaveLength(4);
  // Names and the partner's restrictions never reach storage; the owner's saved restrictions are untouched.
  const everything = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  expect(everything).not.toMatch(/Rave|Sam/);
  expect(await page.evaluate(() => localStorage.getItem("fd.restrictions.device.v1"))).toBeNull();
  // The pair's recent meals were for tonight only: not in anyone's history, not in the session record.
  expect(everything).not.toMatch(/togetherMeals|"who"/);
  // Choosing is not eating: no meal was logged.
  expect(await page.evaluate(() => localStorage.getItem("fd.meals.v1"))).toBeNull();
});
