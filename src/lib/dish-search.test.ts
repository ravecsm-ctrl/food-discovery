/** Dish search and "not in our list yet" (R-015 quick meal logging; PRRD §9.4 unknown dishes stay private). */
import { describe, expect, it } from "vitest";
import { loadCatalog } from "@/catalog";
import type { ConfirmedMeal } from "@/engine";
import { confidentMatch, normalize, searchDishes, unlistedFoods } from "./dish-search";

const catalog = loadCatalog();
const names = (q: string, n = 6) => searchDishes(catalog, q, n).map((d) => d.name);

describe("searchDishes", () => {
  it("finds kebab and shawarma by everyday names, including a typo and accents", () => {
    expect(names("kebab")).toEqual(expect.arrayContaining(["Doner Kebab", "Beef Kebab Plate"]));
    expect(names("shwarma")).toEqual(expect.arrayContaining(["Chicken Shawarma Wrap", "Beef Shawarma Rice"]));
    expect(names("döner")[0]).toBe("Doner Kebab");
  });

  it("finds local shorthand and alternate names", () => {
    expect(names("tapsi")[0]).toBe("Tapsilog");
    expect(names("samgyup")[0]).toBe("Samgyeopsal");
    expect(names("yang chow")[0]).toBe("Yangzhou Fried Rice");
    expect(names("xlb")[0]).toBe("Xiaolongbao");
  });

  it("matches any word of the name, not only the start", () => {
    expect(names("fried chicken")).toEqual(expect.arrayContaining(["Korean Fried Chicken"]));
    expect(names("ramen")).toEqual(expect.arrayContaining(["Tonkotsu Ramen", "Shoyu Ramen", "Spicy Miso Ramen"]));
  });

  it("ranks the exact dish first and returns nothing for gibberish", () => {
    expect(names("bulalo")[0]).toBe("Bulalo");
    expect(names("zzqqxx")).toEqual([]);
    expect(names("")).toEqual([]);
  });

  it("normalizes case, accents and punctuation", () => {
    expect(normalize("  Döner-KEBAB! ")).toBe("doner kebab");
  });
});

describe("unlisted foods", () => {
  const meal = (id: string, name: string | null, dishId: string | null = null, at = "2026-11-06T12:00:00.000Z"): ConfirmedMeal => ({
    id,
    dishId,
    unrecognizedName: name,
    consumedAt: at,
    confirmed: true,
    source: "manual",
  });

  it("groups free-text meals by name and suggests a dish once one exists", () => {
    const list = unlistedFoods(catalog, [
      meal("1", "Kebab"),
      meal("2", "kebab ", null, "2026-11-07T12:00:00.000Z"),
      meal("3", "Lola's champorado"),
      meal("4", null, "dish-bulalo"),
    ]);
    expect(list.map((u) => [u.name, u.mealIds.length, u.match?.name ?? null])).toEqual([
      ["Kebab", 2, "Doner Kebab"],
      ["Lola's champorado", 1, null],
    ]);
    expect(list[0]!.lastAt).toBe("2026-11-07T12:00:00.000Z");
  });

  it("only suggests on an exact name or alternate name, never a loose match", () => {
    expect(confidentMatch(catalog, "Shawarma")?.name).toMatch(/Shawarma/);
    expect(confidentMatch(catalog, "chicken")).toBeNull();
    expect(confidentMatch(catalog, "ramen")?.name).toBe("Tonkotsu Ramen");
  });
});
