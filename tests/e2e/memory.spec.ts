import { expect, test, type Page, type Route } from "@playwright/test";

/** Recent meals → quick picks, card labels, "Your data" page and GitHub backup (with a simulated GitHub). */

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

async function addMeal(page: Page, search: string, dish: string, when: string) {
  await page.getByPlaceholder("e.g. Adobo, ramen, pizza").fill(search);
  await page.getByRole("button", { name: dish, exact: true }).click();
  await page.getByRole("button", { name: when }).click();
  await expect(page.getByTestId("recent-meal").filter({ hasText: dish })).toBeVisible();
}

const FRIED = ["dish-lechon-kawali", "dish-korean-fried-chicken", "dish-pork-tonkatsu"];

test("recent meals → three fresh quick picks with labels, then swipe to refine", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Start discovering" }).click();
  await expect(page.getByRole("heading", { name: "What have you eaten recently?" })).toBeVisible();
  await addMeal(page, "lechon", "Lechon Kawali", "Last night");
  await addMeal(page, "korean fried", "Korean Fried Chicken", "Yesterday lunch");
  await addMeal(page, "tonkatsu", "Pork Tonkatsu", "Earlier today");
  await page.getByRole("button", { name: "Show me ideas" }).click();

  await expect(page.getByRole("heading", { name: "Fresh ideas for today" })).toBeVisible();
  const recs = page.getByTestId("recommendation");
  await expect(recs).toHaveCount(3);
  await expect(recs.first().getByTestId("dish-label")).toHaveText(/^[A-Za-z]+ · .+/);
  await expect(recs.first()).toContainText("you've had recently");
  await expect(recs.first()).toContainText("Based only on your recent meals");
  for (const name of ["Lechon Kawali", "Korean Fried Chicken", "Pork Tonkatsu"]) await expect(page.getByTestId("results")).not.toContainText(`Choose ${name}`);

  const meals = await page.evaluate(() => JSON.parse(localStorage.getItem("fd.meals.v1") ?? "[]"));
  expect(meals).toHaveLength(3);
  expect(meals.every((m: { source: string; timeApprox: boolean }) => m.source === "recall" && m.timeApprox)).toBe(true);
  const [rec] = await page.evaluate(() => JSON.parse(localStorage.getItem("fd.eval.sessions.v1") ?? "[]"));
  expect(rec.recommendationRuns[0].trigger).toBe("quick_picks");

  await page.getByRole("button", { name: "Swipe to refine" }).click();
  const card = page.getByTestId("food-card");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("dish-label")).toBeVisible();
  for (let i = 0; i < 5; i++) {
    expect(FRIED).not.toContain(await card.getAttribute("data-dish-id"));
    await page.getByRole("button", { name: "Not tonight" }).click();
  }
});

test("skipping the meals question goes straight to cards (never required)", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Start discovering" }).click();
  await page.getByRole("button", { name: "Skip — start swiping" }).click();
  await expect(page.getByTestId("food-card")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("fd.meals.v1"))).toBeNull();
});

test("a free-text meal is kept privately but does not invent quick picks", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Start discovering" }).click();
  await page.getByPlaceholder("e.g. Adobo, ramen, pizza").fill("Lola's special stew");
  await page.getByRole("button", { name: /Use “Lola's special stew”/ }).click();
  await page.getByRole("button", { name: "Skip — just log the name" }).click(); // describing is optional
  await page.getByRole("button", { name: "Last night" }).click();
  await page.getByRole("button", { name: "Show me ideas" }).click();
  await expect(page.getByTestId("food-card")).toBeVisible(); // no grounded picks → straight to cards
});

test("Your data: variety setting and meal removal persist", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Start discovering" }).click();
  await addMeal(page, "pho", "Chicken Pho", "Yesterday lunch");
  await page.goto("/data/");
  await page.getByRole("radio", { name: /I get bored quickly/ }).check();
  await page.reload();
  await expect(page.getByRole("radio", { name: /I get bored quickly/ })).toBeChecked();
  await expect(page.getByText("Meals you've logged (1)")).toBeVisible();
  await page.getByRole("button", { name: "Remove Chicken Pho" }).click();
  await expect(page.getByText("Meals you've logged (0)")).toBeVisible();
});

/** Simulated GitHub contents API. Records what was sent. */
async function fakeGitHub(page: Page, opts: { private: boolean }) {
  const store: { sha?: string; content?: string; puts: Array<Record<string, unknown>> } = { puts: [] };
  await page.route("https://api.github.com/**", async (route: Route) => {
    const req = route.request();
    const url = req.url();
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) return route.fulfill({ json: { private: opts.private, default_branch: "main", permissions: { push: true } } });
    if (req.method() === "GET") return store.content ? route.fulfill({ json: { sha: store.sha, content: store.content } }) : route.fulfill({ status: 404, json: {} });
    const body = req.postDataJSON() as Record<string, unknown>;
    store.puts.push({ ...body, auth: req.headers()["authorization"] });
    store.sha = `sha${store.puts.length}`;
    store.content = String(body.content);
    return route.fulfill({ status: 201, json: { content: { sha: store.sha } } });
  });
  return store;
}

test("GitHub backup: refuses a public repository", async ({ page }) => {
  await fakeGitHub(page, { private: false });
  await page.goto("/data/");
  await page.getByLabel("Repository").fill("someone/food-data");
  await page.getByLabel("Access token").fill("test-token-not-real");
  await page.getByRole("button", { name: "Connect backup" }).click();
  await expect(page.getByText(/repository is public/)).toBeVisible();
});

test("GitHub backup: connects to a private repo, saves without the token, and restores", async ({ page }) => {
  const gh = await fakeGitHub(page, { private: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Start discovering" }).click();
  await addMeal(page, "adobo", "Chicken Adobo", "Last night");
  await page.goto("/data/");
  await page.getByLabel("Repository").fill("someone/food-data");
  await page.getByLabel("Access token").fill("test-token-not-real");
  await page.getByRole("button", { name: "Connect backup" }).click();
  await expect(page.getByText("Backup connected.")).toBeVisible();
  await expect(page.getByTestId("cloud-status")).toContainText("Last saved");
  expect(gh.puts.length).toBeGreaterThanOrEqual(1);
  const saved = Buffer.from(String(gh.content), "base64").toString("utf8");
  expect(saved).toContain("dish-chicken-adobo");
  expect(saved).not.toContain("test-token-not-real");
  expect(gh.puts[0]!.auth).toBe("Bearer test-token-not-real");

  // wipe the meal locally, then restore from GitHub
  await page.getByRole("button", { name: "Remove Chicken Adobo" }).click();
  await expect(page.getByText("Meals you've logged (0)")).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Restore from GitHub" }).click();
  await expect(page.getByText("Meals you've logged (1)")).toBeVisible();
});

test("dietary restrictions are remembered on the phone but never backed up", async ({ page }) => {
  const gh = await fakeGitHub(page, { private: true });
  await page.goto("/");
  await page.getByRole("button", { name: /Dietary restrictions/ }).click();
  await page.getByRole("checkbox", { name: /Peanut/ }).check();
  await page.getByRole("button", { name: "Save" }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: /1 avoided/ })).toBeVisible();

  await page.goto("/data/");
  await expect(page.getByTestId("restrictions-summary")).toContainText("Avoiding: peanut");
  await page.getByLabel("Repository").fill("someone/food-data");
  await page.getByLabel("Access token").fill("test-token-not-real");
  await page.getByRole("button", { name: "Connect backup" }).click();
  await expect(page.getByText("Backup connected.")).toBeVisible();
  const saved = Buffer.from(String(gh.content), "base64").toString("utf8");
  expect(saved).not.toMatch(/peanut|restriction/i);

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download backup file" }).click()]);
  const fs = await import("node:fs/promises");
  const fileText = await fs.readFile((await download.path())!, "utf8");
  expect(fileText).not.toMatch(/peanut|restriction/i);

  await page.getByRole("button", { name: "Forget restrictions on this phone" }).click();
  await expect(page.getByTestId("restrictions-summary")).toContainText("None set");
});
