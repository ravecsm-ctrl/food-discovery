import { expect, test, type Page } from "@playwright/test";
import { FakeSupabase, TEST_CODE } from "./fake-supabase";

/**
 * M2 cloud food memory in a real browser, against the real database functions (fake Supabase in PGlite).
 * ENG-022 (guest → account), ENG-023/025/026 (sync, corrections), ENG-027 (consent, deletion)
 * AT-001, AT-019, AT-020, AT-031 · R-015, R-020, R-022, R-023, R-024, R-025
 */

test.describe.configure({ mode: "serial" });

const MEAL_ID = "22222222-2222-4222-8222-000000000001";
const NOW = () => new Date(Date.now() - 2 * 3_600_000).toISOString();

async function seedPhone(page: Page) {
  await page.addInitScript(
    ([mealId, at]) => {
      if (localStorage.getItem("fd.seeded")) return;
      localStorage.setItem("fd.seeded", "1");
      localStorage.setItem("fd.meals.v1", JSON.stringify([{ id: mealId, dishId: "dish-lechon-kawali", consumedAt: at, confirmed: true, source: "recall", timeApprox: true }]));
      localStorage.setItem("fd.restrictions.device.v1", JSON.stringify(["peanut", "shellfish"]));
    },
    [MEAL_ID, NOW()],
  );
}

test("opt in as a guest, correct a meal, add email, use a second phone, then delete everything", async ({ browser }, info) => {
  test.skip(info.project.name !== "mobile-chromium", "one end-to-end run is enough");
  const fake = await FakeSupabase.create();

  /* ---------- phone 1: nothing leaves before consent ---------- */
  const ctx1 = await browser.newContext({ ...info.project.use });
  await fake.install(ctx1);
  const p1 = await ctx1.newPage();
  await seedPhone(p1);
  await p1.goto("/data");
  const account = p1.getByTestId("cloud-account");
  await expect(account).toBeVisible();
  await expect(account.getByRole("button", { name: "Save my food history" })).toBeVisible();
  expect(fake.bodies).toEqual([]); // AT-033 / R-025: no network writes before opting in

  await account.getByRole("button", { name: "Save my food history" }).click();
  const consent = p1.getByTestId("consent-sheet");
  await expect(consent).toContainText("Never sent: your dietary restrictions");
  await consent.getByRole("button", { name: "I agree — turn it on" }).click();
  await expect(p1.getByTestId("account-on")).toContainText("guest on this phone");
  await expect(p1.getByTestId("sync-status")).toContainText("Last synced", { timeout: 15_000 });

  const owner = [...fake.users.keys()][0]!;
  const rows = await fake.db.admin<{ dish_id: string }>("select dish_id from public.meal_records where owner_user_id = $1", [owner]);
  expect(rows).toEqual([{ dish_id: "dish-lechon-kawali" }]);

  /* ---------- correct the meal on the phone → cloud follows (R-015, ENG-026) ---------- */
  await p1.getByRole("button", { name: "Edit Lechon Kawali" }).click();
  const editor = p1.getByTestId("meal-editor");
  await editor.getByLabel("What did you eat?").fill("chicken pho");
  await editor.getByRole("button", { name: /Chicken Pho/ }).click();
  await editor.getByRole("button", { name: "Save correction" }).click();
  await expect(p1.getByText("Meal corrected.")).toBeVisible();
  await expect
    .poll(async () => (await fake.db.admin<{ dish_id: string }>("select dish_id from public.meal_records where id = $1", [MEAL_ID]))[0]?.dish_id, { timeout: 15_000 })
    .toBe("dish-chicken-pho");
  const corrected = await fake.db.admin("select 1 from public.domain_events where event_type = 'meal_corrected' and aggregate_id = $1", [MEAL_ID]);
  expect(corrected).toHaveLength(1);

  /* ---------- a swipe session syncs; selecting a dish creates no meal (AT-020) ---------- */
  await p1.goto("/");
  await p1.getByRole("button", { name: "Start discovering" }).click();
  await p1.getByRole("button", { name: "Show me ideas" }).click();
  await p1.getByRole("button", { name: "Swipe to refine" }).click();
  for (let i = 0; i < 3; i++) await p1.getByRole("button", { name: i === 0 ? "Sounds good" : "Not tonight" }).click();
  await p1.getByRole("button", { name: "See picks" }).click();
  await p1.getByRole("button", { name: /^Choose / }).first().click();
  await p1.goto("/data");
  await account.getByRole("button", { name: "Sync now" }).click();
  await expect
    .poll(async () => (await fake.db.admin<{ c: number }>("select count(*)::int as c from public.domain_events where event_type='dish_selected' and actor_user_id=$1", [owner]))[0]?.c, { timeout: 15_000 })
    .toBe(1);
  const reactions = await fake.db.admin<{ c: number }>("select count(*)::int as c from public.reaction_events where actor_user_id = $1 and invalidated_at is null", [owner]);
  const localReactions = await p1.evaluate(
    () => (JSON.parse(localStorage.getItem("fd.eval.sessions.v1") ?? "[]") as Array<{ exposures: Array<{ reaction: string | null }> }>).flatMap((x) => x.exposures).filter((e) => e.reaction).length,
  );
  expect(localReactions).toBeGreaterThanOrEqual(1);
  expect(reactions[0]!.c).toBe(localReactions); // the cloud copy matches the phone exactly
  const meals = await fake.db.admin<{ c: number }>("select count(*)::int as c from public.meal_records where owner_user_id = $1", [owner]);
  expect(meals[0]!.c).toBe(1);

  // Dietary restrictions were never sent in any request (R-023 privacy decision).
  for (const body of fake.bodies) expect(body).not.toMatch(/peanut|shellfish"\]|restriction/i);

  /* ---------- guest → email account keeps the same identity and data (R-020, AT-019) ---------- */
  await account.getByRole("button", { name: "Add email" }).click();
  await account.getByLabel("Your email").fill("rave@example.test");
  await account.getByRole("button", { name: "Email me a code" }).click();
  await account.getByLabel("6-digit code from the email").fill(TEST_CODE);
  await account.getByRole("button", { name: "Confirm code" }).click();
  await expect(p1.getByTestId("account-on")).toContainText("Signed in as rave@example.test");
  expect([...fake.users.keys()]).toEqual([owner]);

  /* ---------- phone 2: sign in with the code, history arrives ---------- */
  const ctx2 = await browser.newContext({ ...info.project.use });
  await fake.install(ctx2);
  const p2 = await ctx2.newPage();
  await p2.goto("/data");
  const account2 = p2.getByTestId("cloud-account");
  await account2.getByRole("button", { name: "I already have an account" }).click();
  await account2.getByLabel("Sign in with your email").fill("rave@example.test");
  await account2.getByRole("button", { name: "Email me a code" }).click();
  await account2.getByLabel("6-digit code from the email").fill("000000");
  await account2.getByRole("button", { name: "Confirm code" }).click();
  await expect(account2.getByRole("status")).toContainText("didn't work");
  await account2.getByLabel("6-digit code from the email").fill(TEST_CODE);
  await account2.getByRole("button", { name: "Confirm code" }).click();
  await expect(p2.getByTestId("account-on")).toContainText("Signed in as rave@example.test");
  await expect(p2.getByRole("button", { name: "Edit Chicken Pho" })).toBeVisible({ timeout: 15_000 });
  // Restrictions are per phone: phone 2 has none.
  expect(await p2.evaluate(() => localStorage.getItem("fd.restrictions.device.v1"))).toBeNull();

  /* ---------- delete the cloud account; phone data stays (R-024, AT-031) ---------- */
  p1.once("dialog", (d) => void d.accept());
  await account.getByText("What's stored · delete").click();
  await account.getByRole("button", { name: "Stop & delete my cloud data" }).click();
  await expect(account.getByRole("status")).toContainText("were deleted");
  await expect(account.getByRole("button", { name: "Save my food history" })).toBeVisible();
  const left = await fake.db.admin<{ n: number }>(
    "select (select count(*) from public.meal_records where owner_user_id=$1) + (select count(*) from public.discovery_sessions where host_user_id=$1) + (select count(*) from auth.users where id=$1) as n",
    [owner],
  );
  expect(Number(left[0]!.n)).toBe(0);
  await expect(p1.getByRole("button", { name: "Edit Chicken Pho" })).toBeVisible();

  await ctx1.close();
  await ctx2.close();
});
